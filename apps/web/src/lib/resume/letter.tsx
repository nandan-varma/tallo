import { Document, Page, StyleSheet, Text } from "@react-pdf/renderer";
import type { Resume, ResumeStyle } from "@tallo/contracts";
import { safeText } from "@/lib/resume/layout";
import { paragraphs } from "@/lib/resume/letter-text";

const FONTS = {
  classic: { regular: "Times-Roman", bold: "Times-Bold" },
  modern: { regular: "Helvetica", bold: "Helvetica-Bold" },
} as const;

const GREY = "#4b5563";

/**
 * A cover letter as a PDF, in the resume's typeface and paper: the name and a contact line as a header, then
 * the letter body. Text is real text in reading order, like the resume.
 */
export function LetterPdf({
  resume,
  style,
  letter,
}: {
  resume: Resume;
  style: ResumeStyle;
  letter: string;
}) {
  const font = FONTS[style.template];
  const modern = style.template === "modern";

  const s = StyleSheet.create({
    page: {
      fontFamily: font.regular,
      fontSize: 11,
      lineHeight: 1.5,
      color: "#111827",
      padding: 72,
    },
    name: {
      fontFamily: font.bold,
      fontSize: 18,
      lineHeight: 1.15,
      color: modern ? style.accent : "#111827",
      textAlign: modern ? "left" : "center",
    },
    contact: {
      marginTop: 4,
      marginBottom: 24,
      fontSize: 10,
      color: GREY,
      textAlign: modern ? "left" : "center",
    },
    paragraph: { marginBottom: 10 },
  });

  const contact = [resume.email, resume.phone, resume.location].filter(Boolean).join(" | ");

  return (
    <Document title={`${resume.name || "Cover letter"}`} author={resume.name} creator="Tallo">
      <Page size={style.paper === "a4" ? "A4" : "LETTER"} style={s.page}>
        {resume.name ? <Text style={s.name}>{safeText(resume.name)}</Text> : null}
        {contact ? <Text style={s.contact}>{safeText(contact)}</Text> : null}
        {paragraphs(letter).map((paragraph, i) => (
          <Text key={i} style={s.paragraph}>
            {safeText(paragraph)}
          </Text>
        ))}
      </Page>
    </Document>
  );
}
