import simplecadapi as scad
from simplecadapi import ql


def build_model():
    with scad.GraphSession() as session:
        plate = scad.make_box_rsolid(80.0, 50.0, 6.0)
        plate = scad.apply_tag(plate, "role.mounting_plate")
        hole = scad.make_cylinder_rsolid(6.0, 8.0, bottom_face_center=(0.0, 0.0, -1.0))
        result = scad.cut_rsolid(plate, hole, skip_non_intersecting=False)
        result = scad.apply_tag(result, "role.finished_part")
        selected = ql.select([result]).where(ql.tag("role.finished_part")).all()
        print("grounding finished solid count", len(selected))
        print("grounding final volume", result.get_volume())
    return result, session
