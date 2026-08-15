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
        'A Claude Code plugin that runs agent teams for you, routes work to the cheapest model that can do it, and gets better at your repo the more you use it.',
      // `logo` is deliberately NOT set. It takes an image path and emits an
      // `<img>`, which would mean shipping the jackal a third time as a file
      // that nothing keeps in step with `Logo.astro` and `public/favicon.svg`.
      // The mark reaches this header through the `SiteTitle` override below,
      // as a component, inheriting `currentColor`.
      favicon: '/favicon.svg',
      // Starlight ships its own `linkedin` glyph, so the docs header does NOT
      // go through `landing/Icon.astro` — that component belongs to the
      // landing page and importing it here would put the same mark on two
      // different rendering paths, which is how the two drift apart.
      social: [
        { icon: 'github', label: 'GitHub', href: REPO },
        { icon: 'linkedin', label: 'LinkedIn', href: 'https://www.linkedin.com/in/jacekjanczura/' },
      ],
      editLink: {
        // Starlight builds this as `baseUrl + entry.filePath`, where filePath
        // is relative to the Astro project root (`site/`). Hence the trailing
        // `/site/` — dropping it points every edit link at a path that does
        // not exist in the repository.
        baseUrl: `${REPO}/edit/main/site/`,
      },
      lastUpdated: false,
      customCss: ['./src/styles/custom.css'],
      // DARK ONLY, and enforced through the integration's own override slots
      // rather than by out-shouting its stylesheet.
      //
      // Starlight has no `forceDark` option (checked against 0.41.4). What it
      // has is component overrides, and the theme is only ever applied by two
      // of them: `ThemeProvider` writes `data-theme` on <html>, `ThemeSelect`
      // draws the picker and rewrites it on change. Replace both and the
      // palette Starlight defines on bare `:root` — which is the dark one —
      // is the only one that can ever apply. The `:root[data-theme='light']`
      // block in the theme's props.css becomes unreachable rather than
      // overridden, so no future declaration inside it can win a specificity
      // fight this site did not know it was having.
      //
      // `SiteTitle` is the third override and is unrelated to the theme: it
      // puts the jackal mark in the docs header.
      components: {
        ThemeProvider: './src/components/starlight/ThemeProvider.astro',
        ThemeSelect: './src/components/starlight/ThemeSelect.astro',
        SiteTitle: './src/components/starlight/SiteTitle.astro',
      },
      defaultLocale: 'root',
      locales: { root: { label: 'English', lang: 'en' } },
      sidebar: [
        {
          label: 'Start',
          items: [
            { label: 'Getting started', slug: 'getting-started' },
            { label: 'Videos', slug: 'videos' },
            { label: 'Architecture', slug: 'architecture' },
            { label: 'Configuration', slug: 'configuration' },
          ],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'Skills and agents', slug: 'skills' },
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
            { label: 'The board', slug: 'board' },
            { label: 'The spend ledger', slug: 'cost' },
            { label: 'Overnight mode', slug: 'overnight' },
            { label: 'FAQ', slug: 'faq' },
          ],
        },
      ],
    }),
  ],
});
