# Contributing

Thank you for helping. This is a small project and the process is simple.

## If you see something wrong

- **A bug, a typo, or a broken widget:** open a pull request with the fix. You do not need to ask first.
- **An explanation that is wrong or misleading:** open an issue, or a pull request if you know the fix. Say which lesson and what is wrong. A pointer to the relevant section of the book helps.
- **A bigger idea** (a new lesson, a new widget, a redesign): open an issue first so we can agree on the shape before you spend time on it.

## Running the site

```bash
python3 -m http.server 4321
```

Open http://localhost:4321. There is nothing to install and nothing to build.

## Ground rules

- **Write in your own words.** Do not copy or closely paraphrase text, figures, or examples from the book. Explain the idea and invent your own example.
- **No build step and no dependencies.** Plain HTML, CSS, and JavaScript modules.
- **One page per lesson.** Keep it short. Add interactivity only where it teaches something.
- **Match what is there.** Reuse the classes in `assets/style.css` and the helpers in `assets/charts.js` before adding new ones.

## Before you open a pull request

- Load the pages you changed and check that the browser console is clean.
- Check both light and dark mode, and a narrow window.
- Keep the pull request to one change. Small pull requests get merged quickly.

A new lesson also needs an entry in the `CHAPTERS` list in `assets/site.js`.
