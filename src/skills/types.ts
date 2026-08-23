// Skill wire types — 镜像 MonoX DebugServer 的 JSON shape。

export interface SkillMeta {
  name: string;
  description: string;
  tier: 1 | 2;
  path: string;
}

export interface SkillFull extends SkillMeta {
  body: string;
}
