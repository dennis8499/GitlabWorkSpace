"""Preserve screencast timing in a compact, shareable animated trace."""
from pathlib import Path
import json
import sys
from PIL import Image

directory = Path(sys.argv[1]).resolve()
report = json.loads((directory/'motion.json').read_text(encoding='utf-8'))
records = [frame for frame in report['frames'] if frame.get('timestamp') is not None]
if len(records) < 2:
    raise RuntimeError('Screencast lacks enough timestamped frames.')
images = []
durations = []
for index, record in enumerate(records):
    with Image.open(directory/record['name']) as source:
        image = source.convert('RGB')
        image.thumbnail((800,800))
        images.append(image.convert('P', palette=Image.Palette.ADAPTIVE, colors=128))
    interval = (records[index+1]['timestamp']-record['timestamp'])*1000 if index+1<len(records) else 100
    durations.append(max(20,round(interval)))
images[0].save(directory/'motion.gif',save_all=True,append_images=images[1:],duration=durations,loop=0,optimize=False)
print(json.dumps({'frames':len(images),'durationMs':sum(durations),'output':str(directory/'motion.gif')}))
