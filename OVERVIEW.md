Excalidraw adds a diagram panel to your workspace. It lists the `.excalidraw` files in the workspace, opens one in the full Excalidraw editor, and lets you create new diagrams. The same file can be edited by you and by your agents at the same time.

Agents get a set of diagram tools: list and read diagrams, create a diagram, add shapes and text, connect shapes with arrows that stay attached, update, delete, align, and build a whole flowchart in one call. Results are short text summaries with element ids, so small local models can use them. The plugin offers these tools to every agent created while it is enabled. Agents created before that do not have them.

Changes appear live. The panel checks the file about once a second, and when you and an agent edit together it merges both sets of changes. If a save is stale, the daemon rejects it and the panel merges the newer file before saving again.

The editor runs in the Paseo desktop app and in the web app. On mobile the panel shows a short notice instead, and agents can still edit diagrams.

Requirements: Paseo 0.11.2 or later. Excalidraw and its fonts are bundled, so the editor works offline.

What it reads and writes: only `.excalidraw` files inside the workspace folder, on the machine that runs the Paseo daemon. Paths outside the workspace, including through symbolic links, are refused. The tools are served from a local HTTP endpoint on 127.0.0.1 that is protected by a secret and scoped to each agent's working directory.

Image formats: besides plain `.excalidraw` JSON, the panel can create, open and save `.excalidraw.svg` and `.excalidraw.png` files. These are real pictures with the editable scene embedded, so they can be used directly in docs. Agents can list and read them, but only the panel can change them, because the picture has to be re-rendered. These formats do not keep a record of deleted elements, so a deletion made while someone else edits the same image can come back after the merge.

Known limits: Chinese, Japanese and Korean text uses your system fonts instead of Excalidraw's bundled CJK font. The interface is English only. The editor is not available on mobile.
