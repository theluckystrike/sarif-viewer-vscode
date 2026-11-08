# Changelog

## 0.1.0

- First release: SARIF 2.1.0 viewer for CodeQL, Semgrep, ESLint, Bandit, Trivy, Checkov, Gitleaks and other tools.
- Table grouped by rule, file, level, tool or baseline; filters for level, baseline state, suppression, tool and text.
- Click to open results at their region, with CI path and `uriBaseId` mapping that is remembered per workspace.
- Code flow stepping, related locations, rule help from Markdown, CWE links and security severity.
- Show in Problems (opt-in), compare two logs by fingerprint, show several logs in one table.
- Background parsing for large logs (a 150 MB log shows its first rows in about 1.5 s).
