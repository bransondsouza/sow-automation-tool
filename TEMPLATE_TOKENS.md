# Building the default Google Slides template

The app never designs a slide from scratch — it takes a **template** you
control (a normal Google Slides file) and swaps placeholder tokens like
`{{PROJECT_NAME}}` for real content. That's what keeps the output fully
editable and on-brand.

You need to do this once, by hand, in the regular Google Slides editor — no
coding involved. Takes about 10–15 minutes.

## Steps

1. Go to [slides.google.com](https://slides.google.com) → **Blank presentation**.
2. Rename it: **"SOW Deck – Default Template"**.
3. Design it however you like (your company branding, fonts, colors, logo) —
   the app only touches the text runs that exactly match a token below. Create
   exactly 9 slides, in this order, and type each token **exactly as shown**
   (including the double curly braces) into the matching text box:

| # | Slide | Put this token in the body text box |
|---|---|---|
| 1 | Project General Information | `{{PROJECT_NAME}}` and `{{CLIENT_NAME}}` in the title area, `{{PROJECT_OVERVIEW}}` in the body |
| 2 | Input Requirements | `{{INPUT_REQUIREMENTS}}` |
| 3 | Project Deliverables/Outputs | `{{DELIVERABLES}}` |
| 4 | High-Level Project Plan/Timeline | `{{TIMELINE}}` |
| 5 | Stakeholder & Team Structure | `{{PROJECT_MANAGER}}` and `{{TEAM_STRUCTURE}}` |
| 6 | Risk Identification & Mitigation Matrix | `{{RISK_MATRIX}}` |
| 7 | Project Governance | `{{GOVERNANCE_CADENCE}}` and `{{COMMUNICATION_PROTOCOL}}` |
| 8 | Escalation Matrix | `{{ESCALATION_MATRIX}}` |
| 9 | Closing Slide | `{{CLOSING_MESSAGE}}` |

**Slides 6–7–8 are AI-generated, not just copy-pasted from the SOW.** Claude
analyzes the project (scope, timeline, deliverables, domain) and produces:
the top 5 risks ranked by likelihood × impact with specific mitigations, a
meeting cadence and communication protocol sized to the project's scale, and
a standard escalation matrix built from the stakeholder placeholders on
Slide 5 — following PM best practice, filling gaps the SOW itself leaves
open. If the SOW already spells out its own cadence or escalation path,
Claude uses that instead of inventing one. Everything else on the other
slides is pulled directly from the SOW text.

Tips:
- List-style fields (deliverables, risks, timeline, escalation matrix, team)
  arrive as multi-line bullet text — put the token in a text box that's tall
  enough to hold several lines, not a single-line title.
- You can reuse a token more than once on the same slide if useful (e.g.
  `{{PROJECT_NAME}}` in a footer on every slide) — every occurrence gets
  replaced.
- Do not put a token inside a table cell for v1 — `replaceAllText` works
  reliably in text boxes and placeholder shapes; table cell support is a
  Phase 1.5 enhancement.

4. When you're happy with the design, copy the file's ID out of its URL:

   `https://docs.google.com/presentation/d/`**`THIS_PART_IS_THE_ID`**`/edit`

5. Put that ID in your environment variables as `DEFAULT_TEMPLATE_ID` (see
   DEPLOYMENT_GUIDE.docx).

6. **Sharing:** the template file must be accessible to whoever signs into the
   app. Easiest for testing: share it with "Anyone with the link → Viewer."
   For the company rollout, share it with the whole Workspace domain instead.

## Letting people use their own template per-upload

Any employee can paste a different Slides link into the "Google Slides
template" field on the Upload page instead of using the default. It just
needs to follow the same token table above and be shared so the uploader's
Google account can view/copy it. The app copies whichever template is
provided — the default is only used when the field is left blank.
