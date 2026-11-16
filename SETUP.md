# Setup

1. Copy everything in this folder into the root of the sarang-cmd/sarang-cmd repo. Keep the old README as README.old.md until you are happy.
2. Push to main. The workflow in .github/workflows/readme-cards.yml refreshes data/contributions.json and cards/ every morning.
3. Preview a frame without animation: `STATIC=1 python scripts/render_readme_cards.py`, then open the SVGs in a browser.
4. Edit the text in scripts/render_readme_cards.py (STACK list, repo cards, working list) and run it again.

The /icons folder from the old README is no longer used. The stack card draws text chips so it needs no external images.
