---
name: python-charts
description: Make charts with matplotlib + numpy. Outputs PNG suitable for share_file.
---

# Python charts

The sandbox already has `python3`, `matplotlib`, `numpy`, and `pandas` installed. Use `write_file` to drop a small Python script into `/workspace/`, then `bash` to run it (`python script.py`). Save the chart with `plt.savefig('/workspace/<name>.png')`, and call `share_file` with that path so the image lands in the Slack thread. Keep the script self-contained — no network access from the sandbox.