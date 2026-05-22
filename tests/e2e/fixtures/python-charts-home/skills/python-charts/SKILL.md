---
name: python-charts
description: Render a chart with matplotlib and share the resulting PNG via the share_file tool. Use when the user asks for a chart, plot, graph, or visualization.
---

# python-charts

When the user asks for a chart:

1. Write a small Python script that uses `matplotlib` to render the
   requested chart. Save it as `/tmp/chart.py`.
2. Run it with `python3 /tmp/chart.py` via the `bash` tool. The script
   should write the chart to `/tmp/chart.png` using
   `plt.savefig('/tmp/chart.png')`.
3. Upload `/tmp/chart.png` to the Slack thread using the `share_file`
   tool. Do not restate the filename in your final prose reply.

`matplotlib`, `numpy`, and `pandas` are pre-installed in the sandbox.
