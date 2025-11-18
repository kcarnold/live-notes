# %%
from typing import Optional, Dict, Any, List
import time
import json
import requests

BASE_URL = 'http://localhost:52195'


# %%
def get_session_id(timeout: float = 2.0) -> str:
    '''Request /onair/session and return the session id.'''
    url = BASE_URL + '/onair/session'
    r = requests.get(url, timeout=timeout)
    r.raise_for_status()
    r.encoding = 'utf-8-sig'  # Handle BOM if present
    return r.text

def get_onair_presentation(session_id: str, timeout: float = 5.0) -> Dict[str, Any]:
    '''Fetch /presentations/onair with the OnAirSessionId header.'''
    url = BASE_URL + '/presentations/onair'
    headers = {'OnAirSessionId': session_id}
    r = requests.get(url, headers=headers, timeout=timeout)
    r.raise_for_status()
    r.encoding = 'utf-8-sig'  # Handle BOM if present
    return r.json()

session_id = get_session_id()
presentation = get_onair_presentation(session_id)

# %%
presentation.keys()

# %%
def get_cur_status(session_id: str, timeout: float = 5.0) -> Dict[str, Any]:
    '''Fetch /onair/statusChanged with the OnAirSessionId header.'''
    url = BASE_URL + '/onair/statusChanged'
    headers = {'OnAirSessionId': session_id}
    r = requests.get(url, headers=headers, timeout=timeout)
    r.raise_for_status()
    r.encoding = 'utf-8-sig'  # Handle BOM if present
    return r.json()
status = get_cur_status(session_id)
status

# %%
from pathlib import Path
def get_proclaim_data_directory():
      if (path := Path.home() / 'Library' / 'Application Support' / 'Proclaim' / 'Data').exists():
          return path
      if (path := Path.home() / 'AppData' / 'Local' / 'Proclaim' / 'Data').exists():
          return path
      raise FileNotFoundError('Proclaim data directory not found.')
      

def find_presentation_db():
    '''Find the most recently modified Proclaim presentation database file.'''
    # first find the Proclaim data directory based on OS
    proclaim_root = get_proclaim_data_directory()
    # then find all PresentationManager.db files under it
    db_files = list(proclaim_root.glob('*/PresentationManager/PresentationManager.db'))
    if not db_files:
        raise FileNotFoundError('No PresentationManager.db files found.')
    # return the most recently modified one
    return str(max(db_files, key=lambda p: p.stat().st_mtime))
db_path = find_presentation_db()
db_path

# %%
import sqlite3

def get_service_item(item_id: str):
    """Get a service item by its ID from the Proclaim database."""
    db_path = find_presentation_db()
    with sqlite3.connect(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM ServiceItems WHERE ServiceItemId = ?", (item_id,))
        row = cursor.fetchone()
        if row is None:
            raise ValueError(f"Service item with ID {item_id} not found.")
        return dict(zip([col[0] for col in cursor.description], row)) if row is not None else None

service_item_id = status['status']['itemId']#['slideIndex']
service_item = get_service_item(service_item_id.replace('-', ''))
service_item

# %%
service_item_content = json.loads(service_item['Content'])

# %%
from lxml import etree
def decode_richtextXML(xml):
    """"
    Decode the rich text XML from Proclaim into plain text.

    The basic XML format is:
    <Paragraph Language="en-US" Margin="0,0,0,0">
        <Run Text="I love You Lord" />
    </Paragraph>
    <Paragraph Language="en-US" Margin="0,0,0,0">
        <Run Text="Oh Your mercy never fails me" />
    </Paragraph>
    etc.

    Each Paragraph contains one or more Run elements, each with a Text attribute (and maybe formatting attributes?).
    """
    result = ''

    root = etree.fromstring('<Song>' + xml + '</Song>', parser=None)
    for paragraph in root:
        runs = paragraph.findall('Run')
        for run in runs:
            result += run.attrib['Text'] + ' '
        result += '\n'
    return result


# %%
slide_content = decode_richtextXML(service_item_content['_richtextfield:Lyrics'])
slide_content

# %%
def split_into_slides(text):
    """Split the text into sections based on blank lines or --."""
    sections = ['']
    for line in text.strip().split('\n'):
        line_stripped = line.strip()
        if line_stripped == '' or line_stripped == '--':
            sections.append('')
        else:
            sections[-1] += line + '\n'
    return [section.strip() for section in sections if section.strip() != '' and not (section.startswith('{Credits}') or section.startswith('{Source}'))]


#     Split the song text into sections. A blank line followed by one of the following, or a line in {braces}, marks a section:
#     Verse, Chorus, Pre-chorus, Bridge, Tag, Title, Interlude
def split_into_sections(text: str) -> Dict[str, List[str]]:
    sections = {}
    current_section_label = None
    section_types = {'Verse', 'Chorus', 'Pre-chorus', 'Bridge', 'Tag', 'Title', 'Interlude'}
    lines = [line.strip() for line in text.splitlines()]

    for i, line in enumerate(lines):
        # Is this a section header?
        # Includes "Verse 1", "Chorus 2", "Pre-Chorus 3", etc.
        if any(line.startswith(st) for st in section_types):
            # If it doesn't have a number, call it #1
            if not any(char.isdigit() for char in line):
                line += ' 1'
            current_section_label = line
        elif line.startswith('{') and line.endswith('}'):
            current_section_label = line[1:-1].strip()
        else:
            sections.setdefault(current_section_label, []).append(line)

    return {label: split_into_slides('\n'.join(lines)) for label, lines in sections.items()}
split_into_sections(slide_content)

# %%
slide_order = service_item_content['CustomOrderSequence']
slide_order

# %%
#     From the Proclaim documentation:
    
#     Verse Tag  Shorthands
#     Verse 	  	V, V1, 1
#     Chorus 	  	C1
#     Pre-chorus 	  	P1
#     Bridge 	  	B
#     Tag 	  	T
#     Title 	  	T (if Tag is not present)
#     Interlude 	  	I
#     Blank 	  	B (Bridge prioritizes over blank)
#     [Custom] 	  	First letter of custom tag


def get_slides_in_order(slide_sections, order_str: str) -> List[str]:
    '''Decode the CustomOrderSequence string into the slides in order.'''
    slides = []

    # Empty order: take all slides.
    if order_str.strip() == '':
        for section in slide_sections.values():
            slides.extend(section)
        return slides

    for token in order_str.split(','):
        token = token.strip()
        # first handle numbers at the end
        trailing_number = ''
        while token and token[-1].isdigit():
            trailing_number = token[-1] + trailing_number
            token = token[:-1]
        token = token.strip()
        lower_token = token.lower()

        # Label
        if token == '':
            assert trailing_number
            label = f"Verse {trailing_number}"
        elif lower_token == 'v' or lower_token == 'verse':
            label = f"Verse {trailing_number or '1'}"
        elif lower_token == 'c' or lower_token == 'chorus':
            label = f"Chorus {trailing_number or '1'}"
        elif lower_token == 'p' or lower_token == 'pre-chorus':
            label = f"Pre-chorus {trailing_number or '1'}"
        elif lower_token == 'b':
            # check if "Bridge" with that number exists
            possible_label = f"Bridge {trailing_number or '1'}"
            if possible_label in slide_sections:
                label = possible_label
            else:
                label = f"Blank"
        elif lower_token == 'bridge':
            label = f"Bridge {trailing_number or '1'}"
        elif lower_token == 't' or lower_token == 'tag':
            label = f"Tag {trailing_number or '1'}"
        elif lower_token == 'i':
            label = f"Interlude {trailing_number or '1'}"
        else:
            label = token
        
        if label == 'Blank':
            slides.append('')
        elif label in slide_sections:
            slides.extend(slide_sections[label])
        else:
            print(f"Warning: label '{label}' ({token}) not found in slide sections.")
    return slides
get_slides_in_order(split_into_sections(slide_content), slide_order)

# %%



