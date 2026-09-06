"""Export the authored Alpine Hike terrain to compact, local browser assets.

The native heightfield and the route are preserved. The distant annulus uses
the same authored rings with fewer angular samples. All far trees are grounded
again on that exported surface. Source textures are CC0 Poly Haven photographs.
"""
from pathlib import Path
import hashlib
import json
import math
import shutil
import numpy as np
from PIL import Image, ImageEnhance
from scipy.ndimage import map_coordinates, gaussian_filter, distance_transform_edt
from scipy.spatial import cKDTree
import matplotlib
matplotlib.use('Agg')
import matplotlib.tri as mtri

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT/'SourceArt/AlpineHike'
OUT = ROOT/'web/public/assets/world'
OUT.mkdir(parents=True, exist_ok=True)


def smooth(a, b, value):
    t = np.clip((value-a)/(b-a), 0, 1)
    return t*t*(3-2*t)


def write_json(path, data):
    path.write_text(json.dumps(data, separators=(',', ':')), encoding='utf-8')


def sample(field, x, ue_y):
    return map_coordinates(field, [(np.asarray(ue_y)+756)/1.5,
                                   (np.asarray(x)+756)/1.5], order=1, mode='nearest')


def convert(p):
    return [round(p[0]/100, 5), round(p[2]/100-1500, 5), round(-p[1]/100, 5)]


def export_massif():
    src = np.load(SOURCE/'Backdrop/Repair/connected_massif_surface.npz')
    points, starts, counts = [], [], []
    for k, (start, count) in enumerate(zip(src['ring_starts'], src['ring_counts'])):
        # Exact native seam, followed by gradually reduced angular detail.
        stride = 1 if k == 0 else 2 if k < 3 else 4
        ids = int(start)+np.arange(0, int(count), stride)
        starts.append(sum(counts)); counts.append(len(ids))
        points.append(np.column_stack((src['xy'][ids], src['z'][ids])))
    points = np.concatenate(points)
    faces = []
    for layer in range(len(starts)-1):
        a0, b0, na, nb = starts[layer], starts[layer+1], counts[layer], counts[layer+1]
        ia = ib = 0
        while ia < na or ib < nb:
            a, b = a0+ia % na, b0+ib % nb
            ta, tb = (ia+1)/na if ia < na else 2, (ib+1)/nb if ib < nb else 2
            if abs(ta-tb) < 1e-10:
                an, bn = a0+(ia+1) % na, b0+(ib+1) % nb
                faces.extend(((b, an, a), (b, bn, an))); ia += 1; ib += 1
            elif ta < tb:
                faces.append((b, a0+(ia+1) % na, a)); ia += 1
            else:
                faces.append((b, b0+(ib+1) % nb, a)); ib += 1
    faces = np.asarray(faces, np.uint32)
    top_count = len(faces)
    tri = mtri.Triangulation(points[:, 0], points[:, 1], faces)
    finder = tri.get_trifinder()
    corners = points[faces]
    normal = np.cross(corners[:, 1]-corners[:, 0], corners[:, 2]-corners[:, 0])
    assert np.all(normal[:, 2] > 0), 'Massif normals must point upward'
    planes = np.column_stack((-normal[:, 0]/normal[:, 2], -normal[:, 1]/normal[:, 2],
        np.einsum('ij,ij->i', normal, corners[:, 0])/normal[:, 2]))

    def height(x, y):
        idx = np.asarray(finder(x, y))
        p = planes[np.maximum(idx, 0)]
        h = p[..., 0]*x+p[..., 1]*y+p[..., 2]
        return np.where(idx >= 0, h, np.nan)

    # Deep outer apron prevents viewing a cut-off floating bottom from the valley.
    outer_ids = np.arange(starts[-1], starts[-1]+counts[-1])
    bottom = points[outer_ids].copy(); bottom[:, 2] = 450
    bottom_start = len(points)
    points = np.concatenate((points, bottom))
    skirt = []
    for i, a in enumerate(outer_ids):
        j = (i+1) % len(outer_ids); b = outer_ids[j]
        skirt.extend(((a, bottom_start+i, b), (b, bottom_start+i, bottom_start+j)))
    faces = np.concatenate((faces, np.asarray(skirt, np.uint32)))
    # This axis mapping is a rotation; the triangle winding remains unchanged.
    web = np.column_stack((points[:, 0], points[:, 2]-1500, -points[:, 1])).astype('<f4')
    with (OUT/'massif.bin').open('wb') as f:
        np.asarray([len(web), faces.size], dtype='<u4').tofile(f)
        web.tofile(f); faces.astype('<u4').tofile(f)
    n = 513
    ax = np.linspace(-4406, 4406, n)
    x, y = np.meshgrid(ax, ax)
    h = height(x, y)
    native = np.fromfile(SOURCE/'Terrain/AlpineHike_Height.r16', '<u2').reshape(1009, 1009)
    nh = 2000+(native.astype(float)-32768)*1000/12800
    h = np.where(np.maximum(abs(x), abs(y)) <= 756, sample(nh, x, y), h)
    h = np.nan_to_num(h, nan=1100)
    np.round((h-450)*20).astype('<u2').tofile(OUT/'outer-height.r16')
    return height, {'vertices': len(web), 'triangles': len(faces), 'topTriangles': top_count,
        'nativeSeamVertices': counts[0], 'bounds': [-4406, 4406],
        'outerHeightSize': n, 'outerHeightOrigin': 450, 'outerHeightScale': .05}


def export_textures():
    sources = {
        'turf.jpg': ROOT/'SourceArt/ForestLake/Terrain/Textures/leafy_grass_diff_2k.jpg',
        'forest-floor.jpg': ROOT/'SourceArt/ForestLake/Terrain/Textures/forest_ground_04_diff_2k.jpg',
        'rock.jpg': SOURCE/'Backdrop/Textures/rock_06_diff_2k.jpg',
        'trail.jpg': SOURCE/'Nature/Textures/rocky_trail_02_diff_2k.jpg',
        'dry-grass.jpg': SOURCE/'Nature/Textures/withered_grass_diff_2k.jpg',
    }
    for target, source in sources.items():
        image = Image.open(source).convert('RGB').resize((1024, 1024), Image.Resampling.LANCZOS)
        image.save(OUT/target, quality=88, optimize=True)
    Image.open(SOURCE/'MountainGreening/T_MountainEcologyMask.png').resize(
        (1024, 1024), Image.Resampling.LANCZOS).save(OUT/'mountain-ecology.png')

    # The original photo is an atlas of separate blades. Reassemble several
    # extracted upright blades into a compact tuft, keeping their actual alpha.
    d = np.asarray(Image.open(SOURCE/'Nature/Textures/grass_medium_02_diff_2k.jpg').convert('RGB'))
    a = np.asarray(Image.open(SOURCE/'Nature/Textures/grass_medium_02_alpha_2k.png').convert('L'))
    photo = Image.fromarray(np.dstack((d, a)), 'RGBA')
    blade_boxes = [(0, 0, 280, 2000), (270, 0, 570, 2000),
                   (775, 0, 1000, 1940), (1110, 0, 1370, 2010)]
    rng = np.random.default_rng(7138)
    tuft = Image.new('RGBA', (512, 512))
    for i in range(22):
        crop = photo.crop(blade_boxes[i % len(blade_boxes)])
        height = int(rng.uniform(265, 475))
        crop = crop.resize((int(rng.uniform(35, 72)), height), Image.Resampling.LANCZOS)
        crop = crop.rotate(float(rng.uniform(-24, 24)), Image.Resampling.BICUBIC, expand=True)
        x = int(rng.uniform(145, 345))-crop.width//2
        tuft.alpha_composite(crop, (x, 508-crop.height))
    def clean_cutout(image):
        pixels = np.asarray(image).copy()
        alpha = pixels[:, :, 3].astype(float)/255
        # Bleed the leaf colour beyond its alpha edge for clean mip filtering.
        # The source photo's antialiased dark matte must not create black dots.
        rgb = np.clip(pixels[:, :, :3].astype(float)/np.maximum(.42, np.sqrt(alpha))[:, :, None], 0, 255)
        _, nearest = distance_transform_edt(alpha < .55, return_indices=True)
        edge = alpha < .55
        rgb[edge] = rgb[nearest[0][edge], nearest[1][edge]]
        pixels[:, :, :3] = rgb.astype('u1')
        return Image.fromarray(pixels)
    clean_cutout(tuft).save(OUT/'grass-tuft.png')
    # Existing CC0 fern/shrub atlas is preserved for broad-leaf undergrowth.
    for stem, source in [('fern', 'fern_02'), ('shrub', 'shrub_02')]:
        base = ROOT/'SourceArt/ForestLake/Nature/Textures'
        color = Image.open(base/(source+'_diff_2k.png')).convert('RGBA')
        color.putalpha(Image.open(base/(source+'_alpha_2k.png')).convert('L'))
        clean_cutout(color.resize((512, 512), Image.Resampling.LANCZOS)).save(OUT/(stem+'.png'))
    return [{'file': key, 'source': str(value.relative_to(ROOT)).replace('\\', '/'),
             'license': 'CC0-1.0', 'provider': 'Poly Haven'} for key, value in sources.items()]


def main():
    terrain = json.loads((SOURCE/'Terrain/terrain.json').read_text())
    fields = np.load(SOURCE/'Terrain/terrain_fields.npz')
    raw = np.fromfile(SOURCE/'Terrain/AlpineHike_Height.r16', '<u2').reshape(1009, 1009)
    h = 2000+(raw.astype(float)-32768)*1000/12800
    shutil.copyfile(SOURCE/'Terrain/AlpineHike_Height.r16', OUT/'height.r16')
    road = fields['road_distance']
    np.minimum(255, np.round(road*4)).astype('u1').tofile(OUT/'road-distance.r8')
    y, x = np.meshgrid(fields['axis'], fields['axis'], indexing='ij')
    slope = fields['slope']; radius = fields['lake_radius']
    rocky = np.maximum(smooth(.46, 1.00, slope), smooth(2360, 2620, h)*.78)
    arid = .22+.30*smooth(1990, 2280, h)+.16*np.sin(x/67)*np.cos(y/51)
    path = 1-smooth(.82, 2.30, road)
    shore = smooth(.95, 1.00, radius)*(1-smooth(1.06, 1.21, radius))
    pixels = np.uint8(np.clip(np.stack((rocky, arid, path, shore), axis=2), 0, 1)*255)
    Image.fromarray(pixels, 'RGBA').save(OUT/'native-surface.png')
    outer_height, massif = export_massif()

    general = json.loads((SOURCE/'Backdrop/Repair/general_placements_repaired.json').read_text())
    hero = json.loads((SOURCE/'Backdrop/Repair/hero_placements_repaired.json').read_text())['groups']
    far = json.loads((SOURCE/'MountainGreening/placements.json').read_text())
    trees, rocks = [], []
    for groups, distant in [(general, False), (hero, False), (far, True)]:
        for g in groups:
            name = g['name']
            is_tree = any(k in name for k in ('Conifer', 'Pine_', 'Fir_'))
            is_rock = any(k in name for k in ('MossRock', 'Slab', 'Boulder'))
            if not (is_tree or is_rock):
                continue
            species = 0 if name.endswith('_A') else 1 if name.endswith('_B') else 2
            for t in g['instances']:
                p = t['location']; sx, sy, sz = t['scale']
                py = p[2]/100
                if distant:
                    py = float(outer_height(p[0]/100, p[1]/100))-.25
                if is_tree:
                    trees.append([p[0]/100, py-1500, -p[1]/100, sx, sz, sy,
                                  math.radians(t['rotation'][1]), species])
                else:
                    rocks.append([*convert(p), sx, sz, sy, math.radians(t['rotation'][1])])
    np.asarray(trees, '<f4').tofile(OUT/'forest.bin')
    np.asarray(rocks, '<f4').tofile(OUT/'rocks.bin')
    props = []
    for p in json.loads((SOURCE/'Backdrop/Repair/prop_placements_repaired.json').read_text()):
        name = p['mesh'].split('/')[-1]
        model = ('trail-sign' if 'Sign' in name else 'trail-marker' if 'Marker' in name
                 else 'trail-bench' if 'Bench' in name else None)
        if model:
            props.append({'model': model, 'position': convert(p['location']),
                          'yaw': math.radians(p['yaw']), 'scale': p['scale']})

    route = np.asarray(terrain['route_points_cm'])/100
    route_web = np.column_stack((route[:, 0], route[:, 2]-1500, -route[:, 1]))
    route_web.astype('<f4').tofile(OUT/'route.bin')
    start = [float(route[0, 0]), float(sample(h, [route[0, 0]], [route[0, 1]])[0]-1500), float(-route[0, 1])]
    arrival = [240., float(sample(h, [240], [249])[0]-1500), -249.]
    provenance = export_textures()
    meta = {'name': 'Lac des Aiguilles', 'version': 1,
        'heightSize': 1009, 'heightStep': 1.5, 'nativeHalfWidth': 756,
        'heightOrigin': 2000, 'heightScale': 1000/12800, 'heightBias': 32768,
        'altitudeOffset': 1500, 'start': start, 'lakeArrival': arrival,
        'lakeCenter': [300, 800, -350], 'waterLevel': 800,
        'lakeOutline': [convert(p) for p in terrain['lake_outline_cm']],
        'routeLength': terrain['route_length_m'], 'elevationGain': terrain['elevation_gain_m'],
        'routePoints': len(route_web), 'trees': len(trees), 'rocks': len(rocks),
        'props': props, 'massif': massif,
        'views': [{'name': v['id'], 'position': convert(v['location_cm']),
                   'rotation': v['rotation_degrees']} for v in terrain['views']],
        'textureProvenance': provenance,
        'provenance': 'Original authored terrain and placement. CC0 Poly Haven texture photographs. No marketplace assets.'}
    write_json(OUT/'world.json', meta)
    report = {'status': 'passed', 'routeLengthMeters': terrain['route_length_m'],
        'positiveAscentMeters': terrain['elevation_gain_m'], 'lakeAltitudeMeters': 2300,
        'startAltitudeMeters': start[1]+1500, 'nativeHeightBytesIdentical':
            (OUT/'height.r16').read_bytes() == (SOURCE/'Terrain/AlpineHike_Height.r16').read_bytes(),
        'nativeHeightSHA256': hashlib.sha256((OUT/'height.r16').read_bytes()).hexdigest(),
        'routeCoordinateMaximumErrorMeters': float(np.max(np.abs(route_web-route_web.astype('<f4')))),
        'forestCount': len(trees), 'groundedDistantTrees': sum(len(g['instances']) for g in far),
        'massif': massif, 'assetBytes': sum(f.stat().st_size for f in OUT.iterdir() if f.is_file())}
    assert report['nativeHeightBytesIdentical'] and report['routeCoordinateMaximumErrorMeters'] < .001
    assert len(trees) >= 51900 and terrain['elevation_gain_m'] > 800
    (OUT/'export-report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
