# Mermaid Walkthrough

An Obsidian plugin to walk through Mermaid sequence diagrams one step at a time, highlighting the active message, its path and participants. 

It has two views:

### Sequence
The diagram as a list of steps under a header of participants that stays pinned while you scroll. Phase headings pin under the participants while their steps scroll past, with any `alt`, `opt` or `loop` heading pinned just below. The current step moves to the top, so you can always see who is involved.

![Sequence walkthrough](./docs/assets/sequence.gif)

### Map 

The participants and their boxes as cards on a canvas, with elbow arrows between them. The current step's label sits on its arrow, with any `alt`, `opt` or `loop` it belongs to in a tab on top. The phase it is in shows in a box at the bottom left of the canvas. Drag cards and boxes into whatever layout you want. The layout is saved per diagram.

![Map walkthrough](./docs/assets/map.gif)


## Installation

[![Add to Obsidian: install Mermaid Walkthrough](docs/assets/add-to-obsidian.svg)](https://community.obsidian.md/plugins/mermaid-walkthrough)

### From Community plugins

1. In Obsidian, open **Settings → Community plugins**.
2. If prompted, select **Turn on community plugins**.
3. Select **Browse**, search for **Mermaid Walkthrough**, and select **Install**.
4. Select **Enable**, or turn it on later under **Settings → Community plugins → Installed plugins**.

Or use the **Add to Obsidian** button above: it opens the plugin's page in the official directory, which hands off to Obsidian to install it.

Updates arrive the same way: **Settings → Community plugins → Check for updates**.

### Manually

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/mkurapov/obsidian-mermaid-walkthrough/releases/latest).
2. Put them in `<vault>/.obsidian/plugins/mermaid-walkthrough/`.
3. Reload Obsidian and enable **Mermaid Walkthrough** under **Settings → Community plugins**.

## Usage

You can open the walkthrough beside a note or inside it. Either way, open a note that contains one or more ```` ```mermaid ```` blocks with a `sequenceDiagram`.

### Beside the note

1. Click the ribbon icon or run **Mermaid Walkthrough: Open for current note**. The walkthrough opens in a split beside the note and follows whichever note is active.
2. Step through with the toolbar buttons or the keyboard.

Each diagram in the note gets its own tab, named after the heading above it. The walkthrough re-reads the note when you edit it.

### Inside the note

![Toggle walkthrough](./docs/assets/toggle.gif)

Hover a sequence diagram and click **View walkthrough**. The walkthrough opens in the diagram's place, in both Live Preview and Reading view. The keyboard shortcuts work while it has focus; click it to get them back after typing elsewhere. **✕** brings the diagram back. Other Mermaid diagrams render as usual and get no button.

A diagram's map layout is shared between the two, so arranging it in one arranges it in the other.

### Settings

- **Render sequence diagram walkthrough inline**: show the walkthrough in place of every sequence diagram, without clicking **View walkthrough**. Off by default. Turning it on or off updates notes that are already open.

To switch it without opening settings, run **Mermaid Walkthrough: Toggle inline walkthroughs** from the command palette, or bind it to a hotkey.

### Keyboard

| Key | Action |
| --- | --- |
| `→` `↓` `j` | Next step |
| `←` `↑` `k` | Previous step |
| `Home` / `End` | First / last step |
| `Esc` | Show all (no step highlighted) |
| `m` | Switch between Sequence and Map |
| `1`–`9` | Switch to diagram tab (beside the note) |

**Next step** and **Previous step** are also commands for the walkthrough beside the note, so you can bind them to hotkeys that work outside the pane.

### Map

- Drag a card to move it, or a box to move it together with its participants. Drag a box's corner to resize it.
- Drag empty space to pan. Pinch or Ctrl/⌘-scroll to zoom.
- **Fit** zooms to the content and **Reset layout** restores the default arrangement.

## Naming phases

Wrap related messages in a `rect` block and name it with a `%%` comment on the next line. The walkthrough shows the name as a heading over that group of steps. Mermaid ignores the comment, so the diagram still renders normally.

````markdown
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
````

Don't put the name after the color (`rect rgb(...) Handshake`): Mermaid reads it as part of the color and draws a black box.

A note that spans every participant, from the first to the last, also starts a phase named by its text. The phase runs until the next such note, or until the block it is in ends.

````markdown
```mermaid
sequenceDiagram
    participant A as Alice
    participant B as Bob

    Note over A,B: Handshake
    A->>B: Hello
    B-->>A: Hi
```
````

`box` groups become the coloured participant groups in both views. `loop`, `alt`, `opt`, `par`, `critical` and `break` blocks show as labelled sections inside their phase. Other notes are steps like any message.

## Development

The plugin is plain JavaScript with no build step. Symlink the repo into a vault and edit in place:

```sh
ln -s "$PWD" <vault>/.obsidian/plugins/mermaid-walkthrough
```

## License

[MIT](LICENSE)
