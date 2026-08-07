import os
import bpy, math, os
from mathutils import Vector

FRAMES = 432
RES = 900
SAMPLES = 64
PREVIEW = os.environ.get("ORB_PREVIEW") == "1"

BLUE = (0.34, 0.70, 1.0, 1.0)
PALE = (0.80, 0.93, 1.0, 1.0)
DEEP = (0.05, 0.21, 0.42, 1.0)

scn = bpy.context.scene
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)

scn.render.engine = "CYCLES"
scn.cycles.device = "GPU"
scn.cycles.samples = SAMPLES
scn.cycles.use_denoising = True
scn.cycles.max_bounces = 6
scn.cycles.transparent_max_bounces = 12
scn.render.resolution_x = RES
scn.render.resolution_y = RES
scn.render.resolution_percentage = 100
scn.render.film_transparent = True
scn.render.image_settings.file_format = "PNG"
scn.render.image_settings.color_mode = "RGBA"
scn.frame_start = 0
scn.frame_end = FRAMES - 1

prefs = bpy.context.preferences.addons["cycles"].preferences
try:
    prefs.compute_device_type = "OPTIX"
except Exception:
    prefs.compute_device_type = "CUDA"
prefs.get_devices()
for d in prefs.devices:
    d.use = d.type != "CPU"


def emission(name, color, strength):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = color
    em.inputs["Strength"].default_value = strength
    nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
    return m


def fresnel_glass(name):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    mix = nt.nodes.new("ShaderNodeMixShader")
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = BLUE
    em.inputs["Strength"].default_value = 1.15
    fr = nt.nodes.new("ShaderNodeFresnel")
    fr.inputs["IOR"].default_value = 1.38
    nt.links.new(fr.outputs["Fac"], mix.inputs["Fac"])
    nt.links.new(tr.outputs["BSDF"], mix.inputs[1])
    nt.links.new(em.outputs["Emission"], mix.inputs[2])
    nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
    return m


def torus(name, major, minor, material, location=(0, 0, 0), rotation=(0, 0, 0), segments=160):
    bpy.ops.mesh.primitive_torus_add(
        major_radius=major,
        minor_radius=minor,
        major_segments=segments,
        minor_segments=6,
        location=location,
        rotation=rotation,
    )
    o = bpy.context.object
    o.name = name
    o.data.materials.append(material)
    bpy.ops.object.shade_smooth()
    return o


root = bpy.data.objects.new("oracle_globe", None)
bpy.context.collection.objects.link(root)
root.rotation_euler = (math.radians(-8), 0, math.radians(-12))

m_grid = emission("grid", BLUE, 1.7)
m_grid_dim = emission("grid_dim", (0.16, 0.38, 0.62, 1.0), 0.8)
m_orbit = emission("orbit", BLUE, 1.4)
m_node = emission("node", PALE, 6.0)

# Latitude bands. The poles stay open so the sphere reads clean instead of tangled.
for i, z in enumerate((-0.72, -0.38, 0.0, 0.38, 0.72)):
    radius = math.sqrt(1.0 - z * z)
    band = torus(f"latitude_{i}", radius, 0.004, m_grid if i == 2 else m_grid_dim, location=(0, 0, z))
    band.parent = root

# Longitude bands. Five great-circle toruses read as ten clean meridians.
for i in range(5):
    phi = math.pi * i / 5
    band = torus(
        f"longitude_{i}",
        1.0,
        0.004,
        m_grid if i % 2 == 0 else m_grid_dim,
        rotation=(math.pi / 2, 0, phi),
    )
    band.parent = root

# Sparse brighter nodes retain the old technical-orb character without becoming particles.
for i, (lat, lon, size) in enumerate((
    (0.38, 0.25, 0.014), (-0.38, 1.8, 0.012),
    (0.72, 3.2, 0.011), (-0.72, 5.1, 0.011),
)):
    r = math.sqrt(1.0 - lat * lat)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=size, location=(r * math.cos(lon), r * math.sin(lon), lat))
    n = bpy.context.object
    n.name = f"node_{i}"
    n.data.materials.append(m_node)
    n.parent = root

# Layered emission shells fake a volumetric halo around the nucleus.
def glow_shell(name, color, strength, alpha):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    mix = nt.nodes.new("ShaderNodeMixShader")
    mix.inputs["Fac"].default_value = alpha
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = color
    em.inputs["Strength"].default_value = strength
    nt.links.new(tr.outputs["BSDF"], mix.inputs[1])
    nt.links.new(em.outputs["Emission"], mix.inputs[2])
    nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
    return m

for i, (rad, strength, alpha) in enumerate(((0.30, 1.6, 0.05), (0.21, 2.2, 0.10), (0.13, 3.2, 0.22))):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, radius=rad)
    shell = bpy.context.object
    shell.name = f"glow_{i}"
    bpy.ops.object.shade_smooth()
    shell.data.materials.append(glow_shell(f"glow_{i}", BLUE, strength, alpha))
    shell.parent = root

bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=0.06)
nucleus = bpy.context.object
nucleus.name = "nucleus"
bpy.ops.object.shade_smooth()
nucleus.data.materials.append(emission("nucleus", PALE, 14.0))
nucleus.parent = root

# Two restrained orbital arcs recreate the previous silhouette.
for i, (rad, rx, rz, thickness) in enumerate((
    (1.18, math.radians(72), math.radians(26), 0.0040),
    (1.29, math.radians(112), math.radians(-22), 0.0032),
)):
    ring = torus(f"orbit_{i}", rad, thickness, m_orbit if i == 0 else m_grid_dim, rotation=(rx, 0, rz), segments=192)
    ring.parent = root

# One satellite gives the very slow rotation a readable cue.
bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=0.018, location=(1.24, 0, 0))
satellite = bpy.context.object
satellite.name = "satellite"
satellite.data.materials.append(m_node)
satellite.parent = root

cam_data = bpy.data.cameras.new("camera")
cam_data.lens = 66
cam = bpy.data.objects.new("camera", cam_data)
bpy.context.collection.objects.link(cam)
cam.location = (0.0, -5.8, 0.9)
cam.rotation_euler = (math.radians(81.2), 0, 0)
scn.camera = cam

# 432 frames encoded at 30fps = a 14.4-second loop. The original 144-frame
# render at 10fps is what made the hero look choppy: the ASSET was 10fps, not
# the playback. Keep FRAMES and the encode fps in step or the loop changes length.
root.rotation_mode = "XYZ"
root.rotation_euler = (math.radians(-8), 0, math.radians(-12))
root.keyframe_insert("rotation_euler", frame=0)
root.rotation_euler = (math.radians(-8), 0, math.radians(348))
root.keyframe_insert("rotation_euler", frame=FRAMES)
for fc in root.animation_data.action.layers[0].strips[0].channelbag(root.animation_data.action_slot).fcurves:
    for kp in fc.keyframe_points:
        kp.interpolation = "LINEAR"

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(os.path.dirname(os.path.abspath(__file__)), "orb.blend"))
os.makedirs("/tmp/orb30", exist_ok=True)
scn.render.filepath = "/tmp/orb30/f_"
if PREVIEW:
    scn.frame_set(0)
    scn.render.filepath = "/tmp/orb30/preview.png"
    bpy.ops.render.render(write_still=True)
else:
    bpy.ops.render.render(animation=True)
print("RENDER_DONE")
