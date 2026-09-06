"""Convert redistributable local Alpine sources to meter-scale web GLBs.

Run using Blender 5.1 --background --python scripts/export-models.py -- all.
The source project is expected two directories above this script's web root.
No Unreal assets or marketplace packages are read. All exports are +Y up;
travel models face +Z. Original project geometry and CC0 sources are credited.
"""
from pathlib import Path
import json, math, sys, tempfile, uuid, struct, io

# A separate ordinary-Python pass uses Pillow to replace Blender's large 16-bit
# embedded PNGs with browser-ready 8-bit textures without touching mesh buffers.
if '--optimize-glbs' in sys.argv:
    from PIL import Image
    folder=Path(__file__).resolve().parents[1]/'public/assets/models'
    for asset in folder.glob('*.glb'):
        raw=asset.read_bytes();size=struct.unpack_from('<I',raw,12)[0]
        document=json.loads(raw[20:20+size]);source=raw[28+size:]
        # Blender's scaled, packed image copies can serialize linear pixel
        # values into an sRGB PNG. Use the original CC0 photo bytes for trees
        # so glTF's required sRGB base-color decoding remains correct.
        is_conifer=asset.name.startswith('conifer-')
        target_version=2 if is_conifer else 1
        if document.get('extras',{}).get('alpineWebOptimized',0)>=target_version:continue
        images={image['bufferView']:image for image in document.get('images',[]) if 'bufferView' in image}
        target=bytearray()
        for index,view in enumerate(document.get('bufferViews',[])):
            chunk=source[view.get('byteOffset',0):view.get('byteOffset',0)+view['byteLength']]
            if index in images:
                picture=Image.open(io.BytesIO(chunk)).convert('RGBA')
                image_name=images[index].get('name','')
                if is_conifer:
                    source_name=image_name.removesuffix('_Web')+'.png'
                    originals=Path(__file__).resolve().parents[2]/'SourceArt/ForestLake/Nature/Textures'
                    original=originals/source_name
                    if not original.is_file():raise FileNotFoundError(f'Missing original tree albedo: {source_name}')
                    picture=Image.open(original).convert('RGBA')
                picture.thumbnail((512,512) if is_conifer else (1024,1024),Image.Resampling.LANCZOS)
                if 'twig' in images[index].get('name','').lower():
                    opacity=Path(__file__).resolve().parents[2]/'SourceArt/AlpineHike/Nature/Textures/fir_tree_01_twig_alpha_2k.png'
                    picture.putalpha(Image.open(opacity).convert('L').resize(picture.size,Image.Resampling.LANCZOS))
                stream=io.BytesIO()
                if picture.getchannel('A').getextrema()[0]==255:
                    picture.convert('RGB').save(stream,format='JPEG',quality=86,optimize=True)
                    images[index]['mimeType']='image/jpeg'
                else:
                    picture.save(stream,format='PNG',optimize=True,compress_level=9)
                    images[index]['mimeType']='image/png'
                chunk=stream.getvalue()
            view['byteOffset']=len(target);view['byteLength']=len(chunk)
            target.extend(chunk);target.extend(b'\0'*((-len(target))%4))
        document['buffers'][0]['byteLength']=len(target)
        document.setdefault('extras',{})['alpineWebOptimized']=target_version
        for mat in document.get('materials',[]):
            if 'twig' in mat.get('name','').lower():mat['alphaMode']='MASK';mat['alphaCutoff']=.45;mat['doubleSided']=True
        header=json.dumps(document,separators=(',',':')).encode();header+=b' '*((-len(header))%4)
        output=struct.pack('<4sII',b'glTF',2,12+8+len(header)+8+len(target))+struct.pack('<II',len(header),0x4e4f534a)+header+struct.pack('<II',len(target),0x004e4942)+target
        asset.write_bytes(output)
        print(asset.name,len(raw),'->',len(output))
    report={}
    for asset in folder.glob('*.glb'):
        raw=asset.read_bytes();size=struct.unpack_from('<I',raw,12)[0];document=json.loads(raw[20:20+size])
        report[asset.stem]={'file':asset.name,'bytes':len(raw),
            'triangles':sum(document['accessors'][primitive['indices']]['count']//3 for mesh in document.get('meshes',[]) for primitive in mesh['primitives']),
            'animation_clips':[clip.get('name','') for clip in document.get('animations',[])],
            'materials':len(document.get('materials',[])),'embedded_images':len(document.get('images',[]))}
    (folder/'export-report.json').write_text(json.dumps(report,indent=2))
    sys.exit(0)

import bpy
import numpy as np
import bmesh, random
from mathutils import Matrix, Vector

WEB=Path(__file__).resolve().parents[1]
PROJECT=WEB.parent
SOURCE=PROJECT/'SourceArt/AlpineHike'
OUT=WEB/'public/assets/models'
OUT.mkdir(parents=True,exist_ok=True)
TEMP=PROJECT/'Saved/AlpineWebExport';TEMP.mkdir(parents=True,exist_ok=True)
tempfile.tempdir=str(TEMP.resolve())
# Python's Windows mode-0700 temporary directory ACL excludes the sandboxed
# Blender writer. Use ordinary inherited ACLs inside this verified export root.
def export_temp_directory(suffix=None,prefix=None,dir=None):
    parent=Path(dir or TEMP).resolve()
    if not parent.is_relative_to(TEMP.resolve()):raise RuntimeError('Unexpected export temporary directory')
    path=parent/((prefix or 'tmp')+uuid.uuid4().hex+(suffix or ''))
    path.mkdir(mode=0o777)
    return str(path)
tempfile.mkdtemp=export_temp_directory
REPORT={}
R=Matrix.Rotation(-math.pi/2,4,'Z')


def select(objects):
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objects:obj.select_set(True)
    bpy.context.view_layer.objects.active=objects[0]


def material(name,color,rough=.8,metal=0):
    mat=bpy.data.materials.new(name);mat.diffuse_color=(*color,1);mat.use_nodes=True
    shader=mat.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value=(*color,1)
    shader.inputs['Roughness'].default_value=rough;shader.inputs['Metallic'].default_value=metal
    return mat


def simplify_materials(objects,max_size=1024):
    cache={};images={}
    for obj in objects:
        if obj.type!='MESH':continue
        for slot in obj.material_slots:
            old=slot.material
            if not old:continue
            if old.name in cache:slot.material=cache[old.name];continue
            if not old.use_nodes:continue
            sources=[node.image for node in old.node_tree.nodes if node.type=='TEX_IMAGE' and node.image]
            diffuse=next((image for image in sources if 'diff' in image.filepath.lower() or 'basecolor' in image.filepath.lower()),None)
            if not diffuse:continue
            alpha=next((image for image in sources if 'alpha' in image.filepath.lower()),None)
            mat=material(old.name+'_Web',(1,1,1),.9)
            shader=mat.node_tree.nodes.get('Principled BSDF')
            key=(diffuse.name,alpha.name if alpha else '')
            if key not in images:
                image=diffuse.copy();image.name=diffuse.name+'_Web'
                image.filepath=bpy.path.abspath(diffuse.filepath)
                if not image.has_data:image.reload()
                width,height=image.size
                factor=min(1,max_size/max(width,height));image.scale(max(1,int(width*factor)),max(1,int(height*factor)))
                if alpha:
                    mask=alpha.copy();mask.filepath=bpy.path.abspath(alpha.filepath)
                    if not mask.has_data:mask.reload()
                    mask.scale(*image.size)
                    rgba=np.empty(image.size[0]*image.size[1]*4,dtype=np.float32);image.pixels.foreach_get(rgba)
                    mask_pixels=np.empty_like(rgba);mask.pixels.foreach_get(mask_pixels)
                    rgba[3::4]=mask_pixels[0::4]
                    image.pixels.foreach_set(rgba);image.update()
                image.file_format='PNG';image.pack();images[key]=image
            node=mat.node_tree.nodes.new('ShaderNodeTexImage');node.image=images[key]
            mat.node_tree.links.new(node.outputs['Color'],shader.inputs['Base Color'])
            if alpha:
                mat.node_tree.links.new(node.outputs['Alpha'],shader.inputs['Alpha'])
                mat.surface_render_method='DITHERED';mat.use_backface_culling=False
            cache[old.name]=mat;slot.material=mat


def reduce(obj,triangles):
    count=sum(len(poly.vertices)-2 for poly in obj.data.polygons)
    if count<=triangles:return
    select([obj]);mod=obj.modifiers.new('WebReduction','DECIMATE');mod.ratio=triangles/count
    bpy.ops.object.modifier_apply(modifier=mod.name)


def trim_loose_foliage(obj,budget):
    mesh=obj.data
    parent=list(range(len(mesh.vertices)))
    def find(x):
        while parent[x]!=x:parent[x]=parent[parent[x]];x=parent[x]
        return x
    for edge in mesh.edges:
        a,b=edge.vertices;parent[find(a)]=find(b)
    components={}
    for polygon in mesh.polygons:
        key=find(polygon.vertices[0]);components[key]=components.get(key,0)+len(polygon.vertices)-2
    keys=sorted(components,key=lambda key:components[key],reverse=True)
    keep=set();total=0
    for key in keys[:8]:
        if total+components[key]<=budget:keep.add(key);total+=components[key]
    remainder=keys[8:];random.Random(3827).shuffle(remainder)
    for key in remainder:
        if total+components[key]<=budget:keep.add(key);total+=components[key]
    bm=bmesh.new();bm.from_mesh(mesh);bm.faces.ensure_lookup_table()
    discard=[bm.faces[p.index] for p in mesh.polygons if find(p.vertices[0]) not in keep]
    bmesh.ops.delete(bm,geom=discard,context='FACES')
    bmesh.ops.delete(bm,geom=[vert for vert in bm.verts if not vert.link_faces],context='VERTS')
    bm.to_mesh(mesh);bm.free();mesh.update()


def tree_pieces(obj):
    pieces=[]
    for material_index,mat in enumerate(obj.data.materials):
        if not any(p.material_index==material_index for p in obj.data.polygons):continue
        piece=obj.copy();piece.data=obj.data.copy();bpy.context.collection.objects.link(piece)
        piece.name=obj.name+'_'+str(material_index)
        bm=bmesh.new();bm.from_mesh(piece.data)
        bmesh.ops.delete(bm,geom=[face for face in bm.faces if face.material_index!=material_index],context='FACES')
        bmesh.ops.delete(bm,geom=[vert for vert in bm.verts if not vert.link_faces],context='VERTS')
        bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=.001)
        bm.to_mesh(piece.data);bm.free();piece.data.update()
        budget=2000 if 'twig' in mat.name.lower() else 700 if 'bark' in mat.name.lower() else 150
        reduce(piece,budget)
        if 'bark' in mat.name.lower():trim_loose_foliage(piece,budget)
        pieces.append(piece)
    return pieces


def export(name,objects,animated=False):
    select(objects)
    path=OUT/(name+'.glb')
    bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB',use_selection=True,
        export_yup=True,export_apply=not animated,export_animations=animated,
        export_animation_mode='ACTIONS',export_force_sampling=True,export_frame_range=False,
        export_skins=True,export_materials='EXPORT',export_extras=True)
    record={'file':path.name,'bytes':path.stat().st_size,
        'triangles':sum(sum(len(p.vertices)-2 for p in o.data.polygons) for o in objects if o.type=='MESH')}
    REPORT[name]=record;print('WEB_ASSET '+json.dumps(record),flush=True)


def horse():
    bpy.ops.wm.open_mainfile(filepath=str(SOURCE/'Mounts/AlpineHorse.blend'))
    arm=next(o for o in bpy.data.objects if o.type=='ARMATURE')
    mesh=next(o for o in bpy.data.objects if o.type=='MESH')
    parent=bpy.data.objects.new('HorseModel',None);bpy.context.collection.objects.link(parent);parent.matrix_world=R
    arm.parent=parent
    for action in list(bpy.data.actions):
        if 'Jump' in action.name:bpy.data.actions.remove(action)
        else:action.name=action.name.replace('A_AlpineHorse_','')
    arm.animation_data.action=bpy.data.actions['Idle'];arm.animation_data.action_slot=arm.animation_data.action.slots[0]
    bpy.context.scene.frame_set(0)
    export('horse',[parent,arm,mesh],True)


def bicycle():
    bpy.ops.wm.open_mainfile(filepath=str(SOURCE/'Mounts/AlpineMountainBike.blend'))
    objects=[obj for obj in bpy.data.objects if obj.type=='MESH']
    for obj in objects:
        obj.name=obj.name.replace('SM_AlpineBike_','')
        if 'Wheel' in obj.name:reduce(obj,6500)
        obj.matrix_world=R@obj.matrix_world
    export('mountain-bike',objects)


def nature():
    bpy.ops.wm.open_mainfile(filepath=str(SOURCE/'Nature/AlpineNature.blend'))
    scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=24
    scene.render.film_transparent=True;scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_mode='RGBA'
    scene.render.resolution_x=512;scene.render.resolution_y=1024;scene.render.resolution_percentage=100
    scene.world=bpy.data.worlds.new('ImpostorWorld');scene.world.use_nodes=True
    scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.7,.76,.87,1)
    scene.world.node_tree.nodes['Background'].inputs[1].default_value=.65
    scene.view_settings.view_transform='Standard';scene.view_settings.look='Medium High Contrast' if 'Medium High Contrast' in [i.name for i in bpy.types.ColorManagedViewSettings.bl_rna.properties['look'].enum_items] else 'None'
    bpy.ops.object.light_add(type='AREA',location=(-15,-20,30));light=bpy.context.object;light.data.energy=3300;light.data.shape='DISK';light.data.size=22
    light.rotation_euler=(Vector((0,0,8))-light.location).to_track_quat('-Z','Y').to_euler()
    bpy.ops.object.camera_add();camera=bpy.context.object;scene.camera=camera;camera.data.type='ORTHO'
    sprites=[]
    for suffix in 'ABC':
        obj=bpy.data.objects['SM_AlpineConifer_'+suffix]
        for other in bpy.data.objects:
            if other.type=='MESH':other.hide_render=other!=obj
        height=float(obj.dimensions.z)*1.04
        camera.location=(0,-45,height/2);camera.rotation_euler=(math.pi/2,0,0);camera.data.ortho_scale=height
        scene.render.filepath=str(OUT/('conifer-'+suffix.lower()+'-impostor.png'))
        if not Path(scene.render.filepath).is_file():bpy.ops.render.render(write_still=True)
        sprites.append({'variant':suffix.lower(),'file':Path(scene.render.filepath).name,
            'width_m':height*.5,'height_m':height,'base_y_m':0,'image_pixels':[512,1024],
            'source_dimensions_m':[float(obj.dimensions.x),float(obj.dimensions.z),float(obj.dimensions.y)]})
    (OUT/'conifer-impostors.json').write_text(json.dumps({'source':'Poly Haven fir_tree_01, CC0; original render of authorized local source models','sprites':sprites},indent=2))
    for suffix in 'ABC':
        obj=bpy.data.objects['SM_AlpineConifer_'+suffix];obj.hide_render=False
        pieces=tree_pieces(obj);simplify_materials(pieces,512);export('conifer-'+suffix.lower(),pieces)
    rock=bpy.data.objects['SM_AlpineBoulder_A'];rock.hide_render=False;reduce(rock,2200);simplify_materials([rock]);export('rock-a',[rock])


def render_web_impostors():
    """Render the exact optimized web trees, keeping the published card pivots.

    Diffuse daylight is intentionally broad: billboards retain baked lighting
    and must not bake the deep self-shadows of a closed forest a second time.
    Render to the private staging folder so publication can follow image QA.
    """
    manifest=json.loads((OUT/'conifer-impostors.json').read_text())
    for sprite in manifest['sprites']:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        scene=bpy.context.scene
        bpy.ops.import_scene.gltf(filepath=str(OUT/('conifer-'+sprite['variant']+'.glb')))
        scene.render.engine='CYCLES';scene.cycles.samples=48
        scene.cycles.transparent_max_bounces=64
        scene.render.film_transparent=True
        scene.render.image_settings.file_format='PNG'
        scene.render.image_settings.color_mode='RGBA'
        scene.render.image_settings.color_depth='8'
        scene.render.resolution_x=512;scene.render.resolution_y=1024;scene.render.resolution_percentage=100
        scene.view_settings.view_transform='Standard';scene.view_settings.look='None'
        scene.view_settings.exposure=0;scene.view_settings.gamma=1
        scene.world=bpy.data.worlds.new('Open alpine daylight');scene.world.use_nodes=True
        background=scene.world.node_tree.nodes['Background']
        background.inputs[0].default_value=(.86,.92,1,1)
        background.inputs[1].default_value=1.6
        bpy.ops.object.light_add(type='SUN',location=(-15,-20,30))
        sun=bpy.context.object;sun.data.energy=2.0;sun.data.angle=.45
        sun.rotation_euler=(Vector((0,0,8))-sun.location).to_track_quat('-Z','Y').to_euler()
        height=sprite['height_m']
        bpy.ops.object.camera_add(location=(0,-45,height/2),rotation=(math.pi/2,0,0))
        scene.camera=bpy.context.object;scene.camera.data.type='ORTHO';scene.camera.data.ortho_scale=height
        scene.render.filepath=str(TEMP/sprite['file'])
        bpy.ops.render.render(write_still=True)


def props():
    for name,source,obj_name,target in [('trail-sign','AlpineTrailSign.blend','SM_AlpineTrailSign',5000),
        ('trail-bench','AlpineTrailProps.blend','SM_AlpineTrailBench',2400),
        ('trail-marker','AlpineTrailProps.blend','SM_AlpineTrailMarker',1100)]:
        bpy.ops.wm.open_mainfile(filepath=str(SOURCE/'Props'/source))
        obj=bpy.data.objects.get(obj_name)
        if obj is None:raise RuntimeError('Missing original prop '+obj_name)
        obj.hide_set(False);obj.hide_render=False;obj.matrix_world=R@obj.matrix_world
        reduce(obj,target);simplify_materials([obj],512);export(name,[obj])


def hiker():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene=bpy.context.scene;scene.unit_settings.system='METRIC';scene.render.fps=30
    mats={'jacket':material('AlpineForestJacket',(.055,.125,.103)),
        'trim':material('JacketPanel',(.095,.19,.145)),
        'trousers':material('GraphiteTrailTrousers',(.065,.083,.094)),
        'skin':material('WarmSkin',(.49,.265,.15)),
        'pack':material('BurntOrangeBackpack',(.64,.20,.065)),
        'strap':material('PackWebbing',(.048,.055,.05)),
        'boot':material('HikingBootLeather',(.20,.13,.072)),
        'sole':material('BootSole',(.025,.03,.025)),
        'metal':material('BrushedBuckles',(.34,.38,.36),.4,.4),
        'glass':material('Sunglasses',(.018,.046,.045),.16,.1),
        'bottle':material('WaterBottle',(.20,.37,.43),.3,.35)}
    bones={
        'Root':((0,0,0),(0,0,.2),None),
        'Hips':((0,0,.99),(0,0,1.10),'Root'),
        'Spine':((0,0,1.07),(0,0,1.47),'Hips'),
        'Head':((0,0,1.53),(0,0,1.77),'Spine')}
    for side,x in [('L',-.125),('R',.125)]:
        bones['Thigh'+side]=((x,0,.99),(x,0,.56),'Hips')
        bones['Shin'+side]=((x,0,.56),(x,0,.13),'Thigh'+side)
        bones['Foot'+side]=((x,0,.13),(x,-.18,.10),'Shin'+side)
        arm_x=-.255 if side=='L' else .255
        bones['UpperArm'+side]=((arm_x,0,1.45),(arm_x,0,1.14),'Spine')
        bones['Forearm'+side]=((arm_x,0,1.14),(arm_x,0,.86),'UpperArm'+side)
        bones['Hand'+side]=((arm_x,0,.86),(arm_x,0,.74),'Forearm'+side)
    data=bpy.data.armatures.new('HikerSkeleton');arm=bpy.data.objects.new('HikerRig',data);scene.collection.objects.link(arm)
    select([arm]);bpy.ops.object.mode_set(mode='EDIT')
    for name,(head,tail,parent) in bones.items():
        bone=data.edit_bones.new(name);bone.head=head;bone.tail=tail
        if parent:bone.parent=data.edit_bones[parent]
    bpy.ops.object.mode_set(mode='OBJECT');parts=[]
    def attach(obj,mat,bone):
        obj.data.materials.append(mats[mat]);group=obj.vertex_groups.new(name=bone)
        group.add(list(range(len(obj.data.vertices))),1,'REPLACE');parts.append(obj)
        return obj
    def ellipsoid(name,center,scale,mat,bone,segments=16):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=segments,ring_count=10,location=center)
        obj=bpy.context.object;obj.name=name;obj.scale=scale
        bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
        for poly in obj.data.polygons:poly.use_smooth=True
        return attach(obj,mat,bone)
    def box(name,center,size,mat,bone,bevel=.02):
        bpy.ops.mesh.primitive_cube_add(size=1,location=center);obj=bpy.context.object;obj.name=name;obj.scale=size
        bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
        mod=obj.modifiers.new('RoundedSeams','BEVEL');mod.width=bevel;mod.segments=2
        bpy.ops.object.modifier_apply(modifier=mod.name);return attach(obj,mat,bone)
    def taper(name,start,end,radii,mat,bone):
        direction=Vector(end)-Vector(start);center=(Vector(start)+Vector(end))/2
        bpy.ops.mesh.primitive_cone_add(vertices=12,radius1=radii[1],radius2=radii[0],depth=direction.length,location=center)
        obj=bpy.context.object;obj.name=name;obj.rotation_euler=direction.to_track_quat('-Z','Y').to_euler()
        for poly in obj.data.polygons:poly.use_smooth=len(poly.vertices)==4
        return attach(obj,mat,bone)
    ellipsoid('TailoredHips',(0,0,1.015),(.183,.125,.14),'trousers','Hips')
    ellipsoid('TechnicalJacket',(0,0,1.295),(.255,.143,.25),'jacket','Spine')
    box('FrontZip',(0,-.143,1.30),(.015,.014,.37),'strap','Spine',.003)
    box('ChestPocket',(-.115,-.140,1.37),(.105,.018,.105),'trim','Spine',.014)
    box('WaistHem',(0,0,1.095),(.365,.252,.045),'strap','Spine',.01)
    taper('Neck',(0,0,1.49),(0,0,1.58),(.068,.071),'skin','Head')
    ellipsoid('Head',(0,-.012,1.672),(.105,.099,.145),'skin','Head')
    ellipsoid('Nose',(0,-.110,1.668),(.025,.032,.027),'skin','Head',12)
    ellipsoid('CapCrown',(0,.001,1.781),(.114,.113,.06),'jacket','Head')
    box('CapBrim',(0,-.101,1.767),(.225,.138,.018),'trim','Head',.015)
    for sign in (-1,1):
        ellipsoid('Ear',(sign*.103,0,1.674),(.026,.025,.044),'skin','Head',12)
        box('Lens',(sign*.047,-.103,1.699),(.081,.018,.039),'glass','Head',.011)
    box('GlassesBridge',(0,-.116,1.699),(.02,.013,.009),'strap','Head',.002)
    # Backpack: contoured main volume, lid, external straps and bottle pocket.
    ellipsoid('BackpackBody',(0,.197,1.285),(.191,.125,.251),'pack','Spine')
    box('BackpackLid',(0,.205,1.50),(.342,.235,.075),'pack','Spine',.03)
    box('BackpackFrontPocket',(0,.313,1.26),(.237,.057,.22),'pack','Spine',.023)
    for sign in (-1,1):
        box('PackCompression',(sign*.118,.322,1.30),(.022,.026,.37),'strap','Spine',.004)
        box('ShoulderStrap',(sign*.142,-.129,1.32),(.042,.025,.32),'strap','Spine',.014)
        ellipsoid('SidePocket',(sign*.178,.20,1.23),(.06,.071,.13),'pack','Spine')
    box('SternumStrap',(0,-.164,1.335),(.275,.019,.021),'strap','Spine',.004)
    box('SternumBuckle',(.026,-.178,1.335),(.031,.01,.031),'metal','Spine',.005)
    ellipsoid('Bottle',(.201,.208,1.305),(.042,.048,.12),'bottle','Spine')
    box('BottleLid',(.201,.208,1.423),(.046,.046,.029),'strap','Spine',.005)
    for side,sign in [('L',-1),('R',1)]:
        x=sign*.125;ax=sign*.255
        taper('TrouserThigh'+side,(x,0,.965),(x,0,.565),(.109,.081),'trousers','Thigh'+side)
        ellipsoid('KneePanel'+side,(x,-.042,.586),(.079,.053,.09),'strap','Shin'+side)
        taper('TrouserShin'+side,(x,0,.55),(x,0,.145),(.076,.052),'trousers','Shin'+side)
        box('Boot'+side,(x,-.059,.095),(.144,.265,.158),'boot','Foot'+side,.035)
        box('BootSole'+side,(x,-.063,.025),(.153,.286,.042),'sole','Foot'+side,.018)
        for i in range(3):box('Laces'+side,(x,-.087-i*.031,.171-i*.012),(.081,.009,.008),'trim','Foot'+side,.003)
        taper('SleeveUpper'+side,(ax,0,1.448),(ax,0,1.147),(.104,.071),'jacket','UpperArm'+side)
        ellipsoid('Elbow'+side,(ax,0,1.145),(.072,.069,.079),'trim','Forearm'+side)
        taper('SleeveLower'+side,(ax,0,1.138),(ax,0,.895),(.072,.052),'jacket','Forearm'+side)
        box('Cuff'+side,(ax,0,.898),(.107,.10,.057),'strap','Forearm'+side,.01)
        ellipsoid('Hand'+side,(ax,-.009,.816),(.046,.037,.068),'skin','Hand'+side)
        ellipsoid('Thumb'+side,(ax-sign*.038,-.018,.825),(.022,.028,.042),'skin','Hand'+side,12)
    select(parts);bpy.context.view_layer.objects.active=parts[0];bpy.ops.object.join();mesh=bpy.context.object;mesh.name='AlpineHiker'
    modifier=mesh.modifiers.new('HikerSkin','ARMATURE');modifier.object=arm;mesh.parent=arm
    # Clip baking uses the same original anatomical rig as the runtime solver.
    arm.animation_data_create()
    for clip,duration in [('Idle',2.4),('Walk',1.0),('Run',.70),('Pedal',1.0),('Ride',1.2)]:
        action=bpy.data.actions.new(clip);action.use_fake_user=True;arm.animation_data.action=action
        for frame in range(int(duration*30)+1):
            t=frame/(duration*30);phase=t*math.tau
            for bone in arm.pose.bones:bone.rotation_mode='XYZ';bone.rotation_euler=(0,0,0);bone.location=(0,0,0)
            arm.pose.bones['Spine'].rotation_euler.x=.03*math.sin(phase) if clip=='Idle' else .13 if clip=='Run' else .04
            if clip in ('Walk','Run'):
                amplitude=.48 if clip=='Walk' else .78
                for side,offset in [('L',0),('R',math.pi)]:
                    cycle=phase+offset
                    arm.pose.bones['Thigh'+side].rotation_euler.x=amplitude*math.cos(cycle)
                    arm.pose.bones['Shin'+side].rotation_euler.x=-max(0,math.sin(cycle))*(.70 if clip=='Walk' else 1.15)
                    arm.pose.bones['UpperArm'+side].rotation_euler.x=-amplitude*.70*math.cos(cycle)
                    arm.pose.bones['Forearm'+side].rotation_euler.x=-.18 if clip=='Walk' else -.9
            elif clip in ('Pedal','Ride'):
                arm.pose.bones['Spine'].rotation_euler.x=.62 if clip=='Pedal' else .06
                for side,offset in [('L',0),('R',math.pi)]:
                    arm.pose.bones['Thigh'+side].rotation_euler.x=-1.20+(.40*math.sin(phase+offset) if clip=='Pedal' else .05*math.sin(phase))
                    arm.pose.bones['Shin'+side].rotation_euler.x=1.35
                    arm.pose.bones['UpperArm'+side].rotation_euler.x=-1.0
                    arm.pose.bones['Forearm'+side].rotation_euler.x=-.55
            for bone in arm.pose.bones:
                bone.keyframe_insert(data_path='rotation_euler',frame=frame);bone.keyframe_insert(data_path='location',frame=frame)
        action.name=clip
    arm.animation_data.action=bpy.data.actions['Idle'];arm.animation_data.action_slot=arm.animation_data.action.slots[0]
    scene.frame_set(0);export('hiker',[arm,mesh],True)


def credits():
    items=[{'files':['horse.glb'],'author':'Quaternius','source':'Ultimate Animated Animal Pack',
        'source_url':'https://quaternius.com/packs/ultimateanimatedanimals.html','license':'CC0-1.0',
        'modifications':'Normalized original horse rig; baked Idle/Walk/Gallop; original project saddle, blanket, reins and bridle.'},
        {'files':['conifer-a.glb','conifer-b.glb','conifer-c.glb','conifer-a-impostor.png','conifer-b-impostor.png','conifer-c-impostor.png'],
        'author':'Poly Haven','source':'fir_tree_01','source_url':'https://polyhaven.com/a/fir_tree_01',
        'license':'CC0-1.0','license_url':'https://polyhaven.com/license','modifications':'Original local preparation, mesh simplification, embedded reduced textures and original transparent renders.'},
        {'files':['rock-a.glb'],'author':'Poly Haven','source':'boulder_01','source_url':'https://polyhaven.com/a/boulder_01',
        'license':'CC0-1.0','license_url':'https://polyhaven.com/license','modifications':'Mesh decimation and embedded reduced textures.'},
        {'files':['mountain-bike.glb','hiker.glb','trail-sign.glb','trail-bench.glb','trail-marker.glb'],
        'author':'Alpine Hike project','source':'Original project-authored Blender geometry, materials and animation',
        'license':'Original project assets','third_party_assets':False}]
    (OUT/'credits.json').write_text(json.dumps({'assets':items,'verified_on':'2026-09-06','units':'meters','up_axis':'+Y','travel_forward_axis':'+Z'},indent=2))
    (OUT/'export-report.json').write_text(json.dumps(REPORT,indent=2))


if __name__=='__main__':
    args=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else ['all']
    if 'impostors' in args:
        render_web_impostors()
        sys.exit(0)
    for name,function in [('horse',horse),('bicycle',bicycle),('nature',nature),('props',props),('hiker',hiker)]:
        if 'all' in args or name in args:function()
    credits()
