with open(r'E:\codex\codex-shop\supabase\functions\wxpusher\index.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# Remove the broken backtick-n and duplicate
import re
content = re.sub(r"scanCount\", \"999999999\"\);
.*scanCount\", \"999999999\"\);", 'scanCount", "999999999");', content)

with open(r'E:\codex\codex-shop\supabase\functions\wxpusher\index.ts', 'w', encoding='utf-8') as f:
    f.write(content)

for i, line in enumerate(content.split('\n')[115:122], 116):
    print(f'{i}: {repr(line)}')
