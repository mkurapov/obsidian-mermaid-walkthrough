# Mermaid Stepper

An Obsidian plugin for stepping through the Mermaid sequence diagrams in a note one message at a time. The active message, its path and its participants are highlighted, and everything else fades out.

It has two views:

- **Sequence**: the diagram as a list of steps under a header of participants that stays pinned while you scroll. The current step moves to the top, so you can always see who is involved.
- **Map**: the participants and their boxes as cards on a canvas, with elbow arrows between them. Drag cards and boxes into whatever layout you want. The layout is saved per diagram.

## Usage

1. Open a note that contains one or more ```` ```mermaid ```` blocks with a `sequenceDiagram`.
2. Click the ribbon icon or run **Mermaid Stepper: Open for current note**. The stepper opens in a split beside the note and follows whichever note is active.
3. Step through with the toolbar buttons or the keyboard.

Each diagram in the note gets its own tab, named after the heading above it. The stepper re-reads the note when you edit it.

### Keyboard

| Key | Action |
| --- | --- |
| `→` `↓` `j` | Next step |
| `←` `↑` `k` | Previous step |
| `Home` / `End` | First / last step |
| `Esc` | Show all (no step highlighted) |
| `m` | Switch between Sequence and Map |
| `1`–`9` | Switch to diagram tab |

**Next step** and **Previous step** are also commands, so you can bind them to hotkeys that work outside the pane.

### Map

- Drag a card to move it, or a box to move it together with its participants. Drag a box's corner to resize it.
- Drag empty space to pan. Pinch or Ctrl/⌘-scroll to zoom.
- **Fit** zooms to the content and **Reset layout** restores the default arrangement.

## Naming phases

Wrap related messages in a `rect` block and name it with a `%%` comment on the next line. The stepper shows the name as a heading over that group of steps. Mermaid ignores the comment, so the diagram still renders normally.

```mermaid
sequenceDiagram
    participant A as Alice
    participant B as Bob

    rect rgba(109, 108, 220, 0.08)
        %% Handshake
        A->>B: Hello
        B-->>A: Hi
    end
```

Don't put the name after the color (`rect rgb(...) Handshake`): Mermaid reads it as part of the color and draws a black box.

`box` groups become the coloured participant groups in both views. `loop`, `alt`, `opt`, `par`, `critical` and `break` blocks show as labelled sections. Notes are steps like any message.

## Installation

### With BRAT

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Community plugins.
2. Run **BRAT: Add a beta plugin for testing** and enter `mkurapov/obsidian-mermaid-stepper`.
3. Enable **Mermaid Stepper** in Settings → Community plugins.

### Manually

Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/mkurapov/obsidian-mermaid-stepper/releases/latest) into `<vault>/.obsidian/plugins/mermaid-stepper/`, then enable the plugin.

## Development

The plugin is plain JavaScript with no build step. Symlink the repo into a vault and edit in place:

```sh
ln -s "$PWD" <vault>/.obsidian/plugins/mermaid-stepper
```

The [Hot Reload](https://github.com/pjeby/hot-reload) plugin reloads it on save.

To release, bump `version` in `manifest.json`, add it to `versions.json`, then create a GitHub release whose tag is the version exactly (no `v` prefix) with `main.js`, `manifest.json` and `styles.css` attached.

## License

[MIT](LICENSE)
