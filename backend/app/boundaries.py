"""Versioned administrative geometry; map rendering never invents a boundary."""
from copy import deepcopy
from functools import lru_cache
import json
import math
from pathlib import Path

BUNDLE = Path(__file__).with_name('data') / 'isere_boundary.geojson'


def validate_isere_feature(feature):
    if feature.get('type') != 'Feature' or str(feature.get('properties', {}).get('code')) != '38':
        raise ValueError('Le contour doit correspondre au département 38')
    geometry = feature.get('geometry') or {}
    polygons = [geometry.get('coordinates')] if geometry.get('type') == 'Polygon' else geometry.get('coordinates') if geometry.get('type') == 'MultiPolygon' else None
    if not polygons:
        raise ValueError('Contour départemental vide ou invalide')
    count = 0
    for polygon in polygons:
        if not polygon:
            raise ValueError('Polygone vide')
        for ring in polygon:
            if len(ring) < 4 or ring[0] != ring[-1]:
                raise ValueError('Anneau de contour invalide')
            for point in ring:
                if len(point) < 2 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in point[:2]):
                    raise ValueError('Coordonnées invalides')
                lon, lat = point[:2]
                if not (4.4 < lon < 6.7 and 44.3 < lat < 46.1):
                    raise ValueError('Coordonnées hors du périmètre de l’Isère')
                count += 1
    if count < 200:
        raise ValueError('Contour trop simplifié pour représenter le département')
    return geometry


@lru_cache(maxsize=1)
def _load_bundle():
    feature = json.loads(BUNDLE.read_text(encoding='utf-8'))
    validate_isere_feature(feature)
    return feature


def isere_boundary():
    feature = _load_bundle()
    metadata = feature['metadata']
    return {
        'status': 'online',
        'source': metadata['source'],
        'source_label': metadata['source_label'],
        'data_vintage': metadata['vintage'],
        'generalization_m': metadata['generalization_m'],
        'updated_at': metadata['retrieved_at'],
        'geometry': deepcopy(feature['geometry']),
    }
