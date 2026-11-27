from app.chunking import chunk_sections
from app.extract import Section, extract
from app.summarizer import extractive_summary


def test_pdf_extraction_keeps_pages_and_title(samples):
    doc = extract(samples / "contracts" / "Mietvertrag-Wohnung-Berlin.pdf")
    assert doc.title == "Mietvertrag Wohnung Berlin"
    assert [s.page for s in doc.sections] == [1, 2]
    assert "Kaltmiete" in doc.sections[1].text


def test_docx_extraction_reads_title_and_tables(samples):
    doc = extract(samples / "Sales-Report-Q3.docx")
    assert doc.title == "Quarterly Sales Report Q3"
    assert "DACH | 4.2 million EUR" in doc.full_text


def test_markdown_title_from_front_matter(samples):
    doc = extract(samples / "notes" / "meetings" / "2026-10-14-roadmap.md")
    assert doc.title == "Roadmap meeting October"
    assert "title:" not in doc.full_text


def test_markdown_title_from_heading(samples):
    assert extract(samples / "notes" / "recipes.md").title == "Family recipes"


def test_chunks_respect_size_and_overlap():
    text = "\n\n".join(f"Paragraph {i} " + "word " * 40 for i in range(30))
    chunks = chunk_sections([Section(text=text, page=3)], size=500, overlap=80)
    assert len(chunks) > 5
    assert all(len(c.text) <= 600 for c in chunks)
    assert all(c.page == 3 for c in chunks)
    # The start of each chunk repeats the end of the previous one.
    assert chunks[1].text[:20] in chunks[0].text


def test_very_long_paragraph_is_split():
    chunks = chunk_sections([Section(text="x" * 5000)], size=1000, overlap=0)
    assert len(chunks) == 5


def test_extractive_summary_is_short():
    s = extractive_summary("One sentence here. " * 100, max_chars=100)
    assert len(s) <= 100 and s.endswith(".")
