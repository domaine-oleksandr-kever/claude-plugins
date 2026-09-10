# Section → Block CSS Variables Pattern

Applies only in a `foundation` checkout (session line `fnd project profile: foundation`, or the
brief's `profile:`); anywhere else ignore this file — `core-section` / `core-image` and the
`use_section_vars` wiring do not exist there, so follow the theme's own section/block patterns.

A pattern where a **section** controls the dimensions of its child **blocks** via CSS custom properties. Blocks can opt in with a `use_section_vars` checkbox — when enabled, block-level inputs are hidden and the block reads CSS variables from the parent section instead.

## How It Works

```
Section (sets CSS vars on wrapper)
  └─ core-section snippet (renders vars via custom_style)
       └─ Block (reads vars via Tailwind arbitrary properties)
```

1. The **section** computes CSS variable values from its own settings
2. Passes them as inline `style` to `core-section` via `custom_style`
3. CSS variables cascade down the DOM to all descendant blocks
4. **Blocks** with `use_section_vars: true` read these variables using Tailwind v4 arbitrary property syntax with fallbacks

## Naming Convention

Variables use the `--block-` prefix and follow the pattern `--block-{property}` / `--block-{property}-mobile`:

| Variable                      | CSS Property                      | Description                                                                         |
| ----------------------------- | --------------------------------- | ----------------------------------------------------------------------------------- |
| `--block-aspect-ratio`        | `aspect-ratio`                    | Desktop aspect ratio                                                                |
| `--block-aspect-ratio-mobile` | `aspect-ratio`                    | Mobile aspect ratio                                                                 |
| `--block-height`              | `height`                          | Desktop height                                                                      |
| `--block-height-mobile`       | `height`                          | Mobile height                                                                       |
| `--block-text-align`          | `text-align`                      | Text alignment                                                                      |
| `--block-horizontal-align`    | `justify-content` / `align-items` | Horizontal alignment (maps to justify-content in flex-row, align-items in flex-col) |
| `--block-vertical-align`      | `align-items` / `justify-content` | Vertical alignment (maps to align-items in flex-row, justify-content in flex-col)   |

To add a new property (e.g. width), follow the same pattern:

- `--block-width` / `--block-width-mobile`

## Section Side

### 1. Liquid Logic

Compute CSS variable values from section settings and pass them to `core-section` via `custom_style`. Only set a variable when its setting has a value — this lets the block's fallback kick in for unset vars.

Convert px values to rem (divide by 16).

```liquid
{%- liquid
  capture children
    content_for 'blocks'
  endcapture

  assign section_style = ''

  if section.settings.aspect_ratio != blank
    assign section_style = section_style | append: '--block-aspect-ratio: ' | append: section.settings.aspect_ratio | append: ';'
  endif

  if section.settings.aspect_ratio_mobile != blank
    assign section_style = section_style | append: ' --block-aspect-ratio-mobile: ' | append: section.settings.aspect_ratio_mobile | append: ';'
  endif

  if section.settings.height == 'custom'
    assign desktop_rem = section.settings.custom_height_desktop | divided_by: 16.0
    assign mobile_rem = section.settings.custom_height_mobile | divided_by: 16.0
    assign section_style = section_style | append: ' --block-height: ' | append: desktop_rem | append: 'rem;'
    assign section_style = section_style | append: ' --block-height-mobile: ' | append: mobile_rem | append: 'rem;'
  endif

  render 'core-section', section: section, children: children, wrapper: true, custom_style: section_style
-%}
```

### 2. Schema Settings

Section settings provide the actual values. Use raw CSS values (not Tailwind classes) since they go into `var()`:

```json
{
  "type": "select",
  "id": "aspect_ratio",
  "label": "Desktop Aspect Ratio",
  "options": [
    { "value": "", "label": "Auto" },
    { "value": "21/9", "label": "21:9 (Ultra-wide)" },
    { "value": "16/9", "label": "16:9 (Landscape)" },
    { "value": "3/2", "label": "3:2 (Standard)" },
    { "value": "4/3", "label": "4:3 (Classic)" },
    { "value": "1", "label": "1:1 (Square)" },
    { "value": "3/4", "label": "3:4 (Portrait)" },
    { "value": "9/16", "label": "9:16 (Tall Portrait)" }
  ],
  "default": "16/9"
}
```

Height settings use a range in px; the Liquid code converts to rem.

### 3. Preset

In the section preset, set `use_section_vars: true` on blocks that should inherit:

```json
"blocks": {
  "my_image": {
    "type": "core-image",
    "settings": {
      "use_section_vars": true,
      "image_fit": "cover"
    }
  }
}
```

## Block Side

### 1. Checkbox Setting

Add a `use_section_vars` checkbox. When enabled, hide the block's own ratio/height inputs with `visible_if`:

```json
{
  "type": "checkbox",
  "id": "use_section_vars",
  "label": "t:content.use_section_vars",
  "info": "t:info.use_section_vars",
  "default": false
},
{
  "type": "select",
  "id": "image_ratio",
  "label": "t:content.aspect_ratio",
  "options": [ ... ],
  "visible_if": "{{ block.settings.use_section_vars == false }}"
}
```

### 2. Tailwind Arbitrary Property Classes

Use Tailwind v4 arbitrary property syntax: `property-(--css-var,fallback)`. The mobile class applies at base, the desktop class applies at `md:` breakpoint.

**Critical**: Every class must appear as a **complete string literal** in the source file. Tailwind JIT scans source text — it cannot resolve dynamically concatenated class names.

```liquid
if use_section_vars assign ratio_classes =
'aspect-(--block-aspect-ratio-mobile,auto) md:aspect-(--block-aspect-ratio,auto)
h-(--block-height-mobile,auto) md:h-(--block-height,auto)' else # ... regular
Tailwind class logic ... endif
```

### 3. Tailwind Safelist Comment

Add a comment at the top of the block file listing all CSS-variable-based classes. This guarantees Tailwind JIT generates the CSS even if the scanner misses them in Liquid logic:

```liquid
{% comment %}
  Tailwind safelist:
  aspect-(--block-aspect-ratio-mobile,auto) md:aspect-(--block-aspect-ratio,auto)
  h-(--block-height-mobile,auto) md:h-(--block-height,auto)
{% endcomment %}
```

### 4. Applying Classes

Apply `ratio_classes` to the block's wrapper `<div>` (like `core-image`):

```liquid
<div class='{{ ratio_classes }} overflow-hidden'>
  <!-- block content -->
</div>
```

Variant: blocks with no wrapper of their own (like `core-video` → `deferred-media`) build the same
variable classes into the full `class` string passed to the child snippet instead — still complete
literals per branch, never concatenated.

## Translations

`locales/en.default.schema.json` needs `content.use_section_vars` ("Use Section Variables"),
`info.use_section_vars`, and `content.*` labels for any new settings (e.g. `aspect_ratio`,
`aspect_ratio_mobile`).

## Adding a New CSS Variable Property

Same pattern, three touchpoints — e.g. for `max-width`: **section** adds the setting and appends
`--block-max-width` to `custom_style` (plus a `-mobile` counterpart when the value differs per
breakpoint); **block** adds `max-w-(--block-max-width-mobile,none) md:max-w-(--block-max-width,none)`
in the `use_section_vars` branch; **safelist** comment gets the same classes.

## Reference Implementation

- **Section**: `sections/hero-banner.liquid` — passes `--block-aspect-ratio`, `--block-aspect-ratio-mobile`, `--block-height`, `--block-height-mobile`, `--block-text-align`, `--block-horizontal-align`, `--block-vertical-align`
- **Block (image)**: `blocks/core-image.liquid` — reads variables via Tailwind classes on wrapper div
- **Block (video)**: `blocks/core-video.liquid` — reads variables via `class` passed to `deferred-media`
- **Block (group)**: `blocks/core-group.liquid` — reads alignment variables via inline `style` with `var()` passed as `custom_style` to `core-section`

## Common Pitfalls

1. **Dynamic class construction** — Never build Tailwind class names with `| append:`. Each class must be a full literal string in the source. Use `case/when` if the class varies.

2. **Empty CSS variables** — Only set a CSS variable when the section setting has a value. An empty `--block-aspect-ratio: ;` is invalid CSS. Guard with `if setting != blank`.

3. **Old block instances** — When `use_section_vars` is added to an existing block schema, previously created instances default to `false`. Update presets and instruct users to toggle the checkbox or re-add the section.

4. **px → rem** — Always convert pixel values to rem (`divided_by: 16.0`) before setting CSS variables. This ensures consistent scaling.

5. **Fallback values** — The Tailwind fallback (e.g. `auto` in `aspect-(--var,auto)`) applies when the CSS variable is **not defined at all**. If the section explicitly sets `--block-aspect-ratio: 16/9`, that value always wins regardless of the fallback.
