import { type GoogleGenAI } from '@google/genai';
import { spawn } from 'node:child_process';

// Voice configuration per language
const VOICE_CONFIG: Record<string, { voice: string; model: string }> = {
  French: {
    voice: 'Zephyr',
    model: 'gemini-2.5-flash-preview-tts',
  },
  Spanish: {
    voice: 'Zephyr',
    model: 'gemini-2.5-flash-preview-tts',
  },
};

interface AudioFormat {
  sampleRate: number;
  bitsPerSample: number;
  numChannels: number;
}

/**
 * Parse audio format from mime type (e.g., "audio/L16;rate=24000")
 */
function parseAudioFormat(mimeType: string): AudioFormat {
  const [fileType, ...params] = mimeType.split(';').map(s => s.trim());
  const [_, format] = fileType.split('/');

  const audioFormat: Partial<AudioFormat> = {
    numChannels: 1, // Default to mono
  };

  // Parse bit depth from format (e.g., "L16" -> 16 bits)
  if (format?.startsWith('L')) {
    const bits = parseInt(format.slice(1), 10);
    if (!Number.isNaN(bits)) {
      audioFormat.bitsPerSample = bits;
    }
  }

  // Parse parameters (e.g., "rate=24000")
  for (const param of params) {
    const [key, value] = param.split('=').map(s => s.trim());
    if (key === 'rate') {
      audioFormat.sampleRate = parseInt(value, 10);
    }
  }

  // Validate required fields
  if (!audioFormat.sampleRate || !audioFormat.bitsPerSample) {
    throw new Error(`Unable to parse audio format from mime type: ${mimeType}`);
  }

  return audioFormat as AudioFormat;
}

/**
 * Generate MP3 audio from text using Google Gemini TTS
 */
export async function generateTTS(
  geminiClient: GoogleGenAI,
  text: string,
  language: string
): Promise<Buffer> {
  const voiceConfig = VOICE_CONFIG[language];
  if (!voiceConfig) {
    throw new Error(`No voice configured for language: ${language}`);
  }

  const model = voiceConfig.model;
  const contents = [
    {
      role: 'user',
      parts: [
        {
          text: `Read the following complete sentence aloud at a moderate pace: "${text}"`,
        },
      ],
    },
  ];

  const response = await geminiClient.models.generateContentStream({
    model,
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: voiceConfig.voice,
          },
        },
      },
    },
    contents,
  });

  let ffmpegProcess: ReturnType<typeof spawn> | null = null;
  const mp3Chunks: Buffer[] = [];
  let audioFormat: AudioFormat | null = null;

  try {
    for await (const chunk of response) {
      if (!chunk.candidates?.[0]?.content?.parts?.[0]?.inlineData) {
        continue;
      }

      const inlineData = chunk.candidates[0].content.parts[0].inlineData;
      const audioData = Buffer.from(inlineData.data || '', 'base64');

      // DEBUG: Dump raw data to file
      //fs.writeFileSync('debug_raw_audio.pcm', audioData, { flag: 'w' });


      // Initialize ffmpeg on first audio chunk
      if (!ffmpegProcess) {
        audioFormat = parseAudioFormat(inlineData.mimeType || '');

        // Spawn ffmpeg to convert PCM to MP3
        ffmpegProcess = spawn('ffmpeg', [
          '-hide_banner',
          '-loglevel', 'error',
          '-f', 's16le',                          // Input format: signed 16-bit little-endian PCM
          '-ar', audioFormat.sampleRate.toString(), // Sample rate from mime type
          '-ac', audioFormat.numChannels.toString(), // Number of channels
          '-i', 'pipe:0',                         // Input from stdin
          '-f', 'mp3',                            // Output format: MP3
          '-b:a', '128k',                         // Audio bitrate
          'pipe:1',                               // Output to stdout
        ]);

        // Collect MP3 output
        ffmpegProcess.stdout?.on('data', (chunk) => {
          mp3Chunks.push(chunk);
        });

        // Log errors
        ffmpegProcess.stderr?.on('data', (data) => {
          console.error('ffmpeg stderr:', data.toString());
        });
      }

      // Write PCM audio to ffmpeg stdin
      ffmpegProcess.stdin?.write(audioData);
    }

    // Close ffmpeg stdin to signal end of input
    ffmpegProcess?.stdin?.end();

    // Wait for ffmpeg to finish
    await new Promise<void>((resolve, reject) => {
      if (!ffmpegProcess) {
        return reject(new Error('ffmpeg process not initialized'));
      }

      ffmpegProcess.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg exited with code ${code}`));
        }
      });

      ffmpegProcess.on('error', reject);
    });

    return Buffer.concat(mp3Chunks);
  } catch (error) {
    // Kill ffmpeg if still running
    if (ffmpegProcess && !ffmpegProcess.killed) {
      ffmpegProcess.kill();
    }
    throw error;
  }
}
