/**
 * Tailwind v4, added to an app that already had 6,500 lines of hand-written
 * CSS. See the `@theme` block in `app/globals.css` for what it is allowed to
 * generate — the short version is: this project's colours and nothing else.
 */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
