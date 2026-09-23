import { doc, part, sketch, line, arc, circle, extrude, revolve, frame, XY, XZ, YZ, hole, linearPattern, tag, bodies } from "@aicad/std";

doc({ name: "knob_queries", description: "Every query op and predicate of SPEC-v1 §5.3 in tags on a revolved knob with a hole and a pattern" });

part("knob");
const profile = sketch(XZ, {
  axis_seg: line([0, 0], [0, 20]),
  top: line([0, 20], [15, 20]),
  rim: line([15, 20], [15, 0]),
  bottom: line([15, 0], [0, 0]),
});
const body1 = revolve(profile, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 270 });
const shaft = hole(body1.side("bottom"), { at: { c: [0, 0] }, d: 6, depth: { blind: 12 } });
const copies = linearPattern([body1], { dir: { cylinder: body1.side("rim") }, count: 2, spacing: 40 });
const qEndcap = tag(body1.endcap("start", { body: "rim" }));
const qSidesMember = tag(body1.sides({ body: "top" }));
const qBodyMember = tag(body1.body("axis_seg"));
const qBodies = tag(bodies().any());
const qHoleWall = tag(shaft.wall("c"));
const qCreated = tag(shaft.faces({ role: "tip" }).exactly(3));
const qInstance = tag(copies.instance(1));
const qUnion = tag(body1.side("top").and(body1.side("rim")));
const qIntersect = tag(body1.side("top").edges().common(body1.side("rim").edges()));
const qMinus = tag(body1.sides().minus(body1.side("top")));
const qOwner = tag(shaft.floor("c").owner());
const qLargest = tag(bodies().faces().largest());
const qSmallest = tag(body1.body().edges().smallest());
const qType = tag(body1.faces().cylinders());
const qPerp = tag(bodies().edges().perpendicular([0, 0, 1]));
const qConcave = tag(bodies().edges().concave().any());
const qSmooth = tag(bodies().edges().smooth().any());
const qRadius = tag(bodies().faces().radius({ min: 2, max: 4 }));
const qRadiusEq = tag(bodies().edges().radius(15));
const qVerticesOfFace = tag(body1.endcap("end").vertices());
const qFacesOfEdges = tag(body1.edgeAt("top", "start").faces());
const qEdgesOfVertices = tag(qVerticesOfFace.edges());
const qExtremeAxis = tag(bodies().faces().min({ edge: body1.edgeAt("rim", "end"), flip: true }).one());
