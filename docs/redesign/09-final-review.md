# Prompt 9: Final self-review

Source spec for module **M12**.

```text
Review every Agent Office screen against the design system and fix what fails:
1. 5-second test: are working / needs-you / done / next / cost visible on the Command Center without a click?
2. Is amber used ONLY for needs-you, and red ONLY for errors and over-budget? (grep the CSS and components)
3. Do any raw paths, system tags (<ide_…>, <system-reminder>) or hook event names leak into the UI?
4. Does all long text truncate gracefully (names, paths middle, commands, prompts 2-line)? Do tokens stay on one line?
5. Does every panel have empty, loading, error and offline states?
6. Accessibility: 4.5:1 contrast in both themes, state never shown by color alone, every control keyboard-reachable with a visible focus ring, Esc closes overlays, reduced motion respected, the hover card stays inside the viewport.
7. The hook never blocks or crashes a Claude Code session when the server is down (spools and exits 0).
List each issue you found and what you changed.
```
