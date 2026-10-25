"""Bounded, signature-checked document storage, with collision-free names."""
from pathlib import Path
import secrets
from fastapi import HTTPException
from PIL import Image
import io

def read_document(stream, filename, limit):
    raw=stream.read(limit+1)
    if not raw:raise HTTPException(400,'Le fichier est vide')
    if len(raw)>limit:raise HTTPException(413,'Document trop volumineux')
    extension=Path(filename).suffix.lower()
    if extension=='.pdf':
        if not raw.startswith(b'%PDF-') or b'%%EOF' not in raw[-2048:]:raise HTTPException(400,'Le contenu ne correspond pas à un PDF valide')
    elif extension in ('.png','.jpg','.jpeg'):
        try:
            with Image.open(io.BytesIO(raw)) as image:
                if image.format != ('PNG' if extension=='.png' else 'JPEG'):raise ValueError()
                image.verify()
        except Exception:
            raise HTTPException(400,'Le contenu ne correspond pas à une image valide') from None
    else:raise HTTPException(400,'Type de fichier interdit')
    return raw

def store_document(directory, filename, raw):
    directory=Path(directory);directory.mkdir(parents=True,exist_ok=True)
    path=directory/(secrets.token_hex(16)+'_'+filename)
    with path.open('xb') as stream:stream.write(raw)
    return path
