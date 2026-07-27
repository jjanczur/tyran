// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { unified } from '@astrojs/markdown-remark';
import rehypeMermaid from 'rehype-mermaid';

const REPO = 'https://github.com/jjanczur/tyran';

// Mermaid is rendered at BUILD time into inline SVG. Two consequences are the
// reason for the choice: no mermaid.js is shipped to the reader, and a diagram
// that fails to parse fails the build instead of failing silently in someone's
// browser.
//
// `dark` is deliberately NOT used. It emits a <picture> switched by
// `prefers-color-scheme`, and Starlight's theme is a manual toggle that writes
// `data-theme` on <html> — a reader who flips the site to light while their OS
// is dark would get the dark diagram. So one neutral SVG is rendered and
// recoloured by CSS in `src/styles/custom.css`, which follows the toggle
// because it keys off the same attribute Starlight sets.
const MERMAID = {
  strategy: /** @type {const} */ ('inline-svg'),
  mermaidConfig: {
    theme: /** @type {const} */ ('base'),
    fontFamily: 'var(--sl-font, ui-sans-serif, system-ui, sans-serif)',
    themeVariables: {
      // Mid-tone values chosen to be legible before the CSS layer runs; the
      // stylesheet overrides them per theme. Backgrounds are transparent so
      // the page colour shows through in both themes.
      background: 'transparent',
      mainBkg: 'transparent',
      primaryColor: 'transparent',
      lineColor: '#8b8b8b',
      textColor: '#8b8b8b',
      primaryTextColor: '#8b8b8b',
      primaryBorderColor: '#8b8b8b',
    },
  },
};

// GitHub Pages serves a project site from a sub-path. `site` + `base` are what
// make every generated href and asset URL carry the `/tyran` prefix; without
// `base` the build is silently correct locally and 404s on production, which
// is the failure this project would call a false guarantee in a config file.
export default defineConfig({
  site: 'https://jjanczur.github.io',
  base: '/tyran',
  markdown: {
    // Shiki must not claim the mermaid fences before rehype-mermaid sees them.
    syntaxHighlight: { type: 'shiki', excludeLangs: ['mermaid'] },
    // `markdown.rehypePlugins` still works but Astro 7 deprecates it and warns
    // on every build; `markdown.processor` is the supported spelling. Shipping
    // the deprecated one would be a build-time warning nobody reads until it
    // becomes a build-time error in Astro 8.
    processor: unified({ rehypePlugins: [[rehypeMermaid, MERMAID]] }),
  },
  integrations: [
    starlight({
      title: 'Tyran',
      description:
        'A task conductor for Claude Code that refuses to believe any agent which cannot show raw command output as proof.',
      // No logo/wordmark is set here on purpose: inventing a brand mark is a
      // visual decision, and this story is the docs foundation. The repo
      // already carries `assets/banner.jpg` for whoever makes that call.
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: REPO }],
      editLink: {
        // Starlight builds this as `baseUrl + entry.filePath`, where filePath
        // is relative to the Astro project root (`site/`). Hence the trailing
        // `/site/` — dropping it points every edit link at a path that does
        // not exist in the repository.
        baseUrl: `${REPO}/edit/main/site/`,
      },
      lastUpdated: false,
      customCss: ['./src/styles/custom.css'],
      // Dark + light are both first-class; Starlight ships the toggle and
      // Pagefind-backed search by default, and both are asserted in the build
      // measurement rather than assumed.
      defaultLocale: 'root',
      locales: { root: { label: 'English', lang: 'en' } },
      sidebar: [
        {
          label: 'Start',
          items: [
            { label: 'Getting started', slug: 'getting-started' },
            { label: 'Architecture', slug: 'architecture' },
            { label: 'Configuration', slug: 'configuration' },
          ],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'The roster and model routing', slug: 'agents' },
            { label: 'Self-improvement', slug: 'self-improvement' },
          ],
        },
        {
          label: 'Gates',
          items: [
            { label: 'Hook runtime', slug: 'hooks' },
            { label: 'Evidence gate', slug: 'evidence-gate' },
            { label: 'Policy gate', slug: 'policy-gate' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Journal', slug: 'journal' },
            { label: 'Projections', slug: 'projections' },
            { label: 'Doctor', slug: 'doctor' },
            { label: 'FAQ', slug: 'faq' },
          ],
        },
      ],
    }),
  ],
});
