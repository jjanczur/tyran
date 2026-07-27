/**
 * Base-prefixed URLs for the landing page.
 *
 * The site is served from `https://jjanczur.github.io/tyran/`, so every
 * root-absolute link has to carry `/tyran`. `site/scripts/check-base-prefix.mjs`
 * fails the build when one does not, and it runs in the Pages workflow — the
 * failure mode it guards is a link that works locally and 404s only in
 * production.
 *
 * Astro rewrites `href` on its own components but NOT on hand-written `<a>`
 * tags, which is what this landing is made of. So the prefix is applied here,
 * once, instead of being typed twenty times.
 *
 * `BASE_URL` is normalised rather than trusted: Astro derives its trailing
 * slash from `trailingSlash`, and `'/tyran' + 'faq/'` and `'/tyran/' + 'faq/'`
 * are different bugs.
 */
const RAW = import.meta.env.BASE_URL;
const BASE = RAW.endsWith('/') ? RAW : `${RAW}/`;

/** A path inside this site, with the base prefix applied exactly once. */
export const url = (path: string): string => BASE + path.replace(/^\/+/, '');

export const REPO = 'https://github.com/jjanczur/tyran';

/**
 * Where the footer signature points.
 *
 * Here rather than in `SiteFooter.astro` for the reason at the top of this
 * file: an external URL typed into a component is the copy that gets missed
 * when it changes, and the footer is not the only surface that can carry it —
 * the docs pages reach LinkedIn through Starlight's `social` config in
 * `astro.config.mjs`.
 */
export const AUTHOR = {
  site: 'https://janczura.com',
  linkedin: 'https://www.linkedin.com/in/jacekjanczura/',
} as const;

/**
 * `releases/latest`, never a pinned tag.
 *
 * A hard-coded `releases/tag/v0.1.0` is correct on the day it is written and
 * quietly wrong from the next release onward: the link keeps resolving — no
 * 404, no broken-link check anywhere fires — while sending every visitor to
 * an old version. A link that works and points at the wrong thing is worse
 * than one that breaks, because nothing reports it. A test pins this.
 */
export const RELEASE = `${REPO}/releases/latest`;

/** Documentation pages this landing links to, by the slug Starlight serves. */
export const DOCS = {
  gettingStarted: url('getting-started/'),
  architecture: url('architecture/'),
  configuration: url('configuration/'),
  agents: url('agents/'),
  selfImprovement: url('self-improvement/'),
  hooks: url('hooks/'),
  evidenceGate: url('evidence-gate/'),
  policyGate: url('policy-gate/'),
  journal: url('journal/'),
  projections: url('projections/'),
  doctor: url('doctor/'),
  faq: url('faq/'),
} as const;
