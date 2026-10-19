from striprtf.striprtf import rtf_to_text
from docx import Document
src = r"C:\Users\7onch\Desktop\odluka - napojnice.rtf"
dst = r"C:\Users\7onch\Desktop\odluka - napojnice.docx"
with open(src, "r", encoding="cp1250", errors="ignore") as f:
    rtf = f.read()
text = rtf_to_text(rtf)
doc = Document()
for line in text.splitlines():
    doc.add_paragraph(line)
doc.save(dst)
print("OK: DOCX created", dst)
