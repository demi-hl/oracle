// Canonical Nous design-system layer for the Oracle.
//
// These components are VENDORED from the official @nous-research/ui@0.19.1 source
// (their compiled dist), ported into the tree and rewired to a local `cn` so they
// carry zero `three` weight. This is the same pattern Nous's own apps/desktop uses
// (it vendors the pieces rather than importing the package live) — and it's
// necessary: importing the package directly drags `three` into the client bundle
// because Turbopack does not tree-shake the `import * as THREE` in the package's
// utils barrel out of the real client-component graph (verified: isolated page
// shakes it, the IDEShell→AppShell graph does not).
//
// Homage on top of what Nous built — their exact code, owned and maintainable,
// no 3D baggage. Badge is likewise local (the official Badge genuinely evaluates
// the BlendMode/three chain) with the exact official class strings.
export { Button } from "./button";
export { Switch } from "./switch";
export { Segmented, FilterGroup } from "./segmented";
export { Tabs, TabsList, TabsTrigger } from "./tabs";
export { Progress } from "./progress";
export { Typography, type TypographyProps } from "./typography";
export { Badge } from "./badge";
