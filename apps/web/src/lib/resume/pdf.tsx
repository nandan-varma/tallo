import { Document, Link, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { Resume, ResumeStyle } from "@tallo/contracts";
import type { ReactNode } from "react";
import { type Density, safeText } from "@/lib/resume/layout";

const FONTS = {
  classic: { regular: "Times-Roman", bold: "Times-Bold", italic: "Times-Italic" },
  modern: { regular: "Helvetica", bold: "Helvetica-Bold", italic: "Helvetica-Oblique" },
} as const;

const GREY = "#4b5563";

const dates = (item: { start: string; end: string }) =>
  [item.start, item.end].filter(Boolean).join(" – ");

const href = (url: string) => (/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`);
const shown = (url: string) => url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");

/**
 * The resume as a PDF. Text is real text in reading order (ATS parsers read it), the fonts are the PDF
 * standard ones (nothing to download or embed), and all spacing derives from one `Density`, so fitting a page
 * budget is a matter of picking a density, not editing the content.
 */
export function ResumePdf({
  resume,
  style,
  density,
}: {
  resume: Resume;
  style: ResumeStyle;
  density: Density;
}) {
  const font = FONTS[style.template];
  const modern = style.template === "modern";
  const size = density.font;
  const t = (text: string) => safeText(text);

  const s = StyleSheet.create({
    page: {
      fontFamily: font.regular,
      fontSize: size,
      lineHeight: density.line,
      color: "#111827",
      paddingVertical: density.margin,
      paddingHorizontal: density.margin + 6,
    },
    name: {
      fontFamily: font.bold,
      fontSize: size * (modern ? 2.3 : 2.1),
      lineHeight: 1.15,
      color: modern ? style.accent : "#111827",
      textAlign: modern ? "left" : "center",
    },
    headline: {
      fontSize: size * 1.1,
      color: GREY,
      textAlign: modern ? "left" : "center",
      marginTop: 2,
    },
    contact: {
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: modern ? "flex-start" : "center",
      marginTop: 4,
      fontSize: size * 0.95,
      color: GREY,
    },
    sep: { marginHorizontal: 4 },
    link: { color: GREY, textDecoration: "none" },
    section: { marginTop: density.gap * 1.25 },
    heading: {
      fontFamily: font.bold,
      fontSize: size * (modern ? 1.0 : 1.05),
      textTransform: "uppercase",
      color: modern ? style.accent : "#111827",
      borderBottomWidth: modern ? 0 : 0.8,
      borderBottomColor: "#111827",
      paddingBottom: modern ? 0 : 1.5,
      marginBottom: density.gap * 0.55,
    },
    entry: { marginTop: density.gap * 0.7 },
    entryFirst: { marginTop: 0 },
    row: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" },
    strong: { fontFamily: font.bold },
    italic: { fontFamily: font.italic, color: GREY },
    when: { color: GREY, fontSize: size * 0.95, marginLeft: 8 },
    bullet: { flexDirection: "row", marginTop: density.gap * 0.18, paddingLeft: 8 },
    dot: { width: 10 },
    bulletText: { flex: 1 },
  });

  const Heading = ({ children }: { children: string }) => (
    <Text style={s.heading} minPresenceAhead={40}>
      {t(children)}
    </Text>
  );

  const Section = ({ title, children }: { title: string; children: ReactNode }) => (
    <View style={s.section}>
      <Heading>{title}</Heading>
      {children}
    </View>
  );

  const Bullets = ({ items }: { items: string[] }) => (
    <>
      {items.filter(Boolean).map((item) => (
        <View key={item} style={s.bullet} wrap={false}>
          <Text style={s.dot}>•</Text>
          <Text style={s.bulletText}>{t(item)}</Text>
        </View>
      ))}
    </>
  );

  const Entry = ({
    index,
    left,
    sub,
    right,
    children,
  }: {
    index: number;
    left: string;
    sub?: string;
    right?: string;
    children?: ReactNode;
  }) => (
    <View style={index === 0 ? s.entryFirst : s.entry}>
      <View wrap={false} minPresenceAhead={density.font * 3}>
        <View style={s.row}>
          <Text style={s.strong}>{t(left)}</Text>
          {right ? <Text style={s.when}>{t(right)}</Text> : null}
        </View>
        {sub ? <Text style={s.italic}>{t(sub)}</Text> : null}
      </View>
      {children}
    </View>
  );

  const contact: ReactNode[] = [
    resume.location && <Text key="loc">{t(resume.location)}</Text>,
    resume.phone && <Text key="tel">{t(resume.phone)}</Text>,
    resume.email && (
      <Link key="mail" src={`mailto:${resume.email}`} style={s.link}>
        {t(resume.email)}
      </Link>
    ),
    ...resume.links
      .filter((link) => link.url)
      .map((link) => (
        <Link key={link.url} src={href(link.url)} style={s.link}>
          {t(link.label || shown(link.url))}
        </Link>
      )),
  ].filter(Boolean);

  return (
    <Document title={`${resume.name || "Resume"}`} author={resume.name} creator="Tallo">
      <Page size={style.paper === "a4" ? "A4" : "LETTER"} style={s.page}>
        {resume.name ? <Text style={s.name}>{t(resume.name)}</Text> : null}
        {resume.headline ? <Text style={s.headline}>{t(resume.headline)}</Text> : null}
        {contact.length > 0 && (
          <View style={s.contact}>
            {contact.flatMap((node, i) =>
              i === 0
                ? [node]
                : [
                    <Text key={`s${i}`} style={s.sep}>
                      |
                    </Text>,
                    node,
                  ],
            )}
          </View>
        )}

        {resume.summary ? (
          <Section title="Summary">
            <Text>{t(resume.summary)}</Text>
          </Section>
        ) : null}

        {resume.experience.length > 0 && (
          <Section title="Experience">
            {resume.experience.map((job, i) => (
              <Entry
                key={`${job.company}-${job.title}-${job.start}`}
                index={i}
                left={job.title || job.company}
                sub={[job.title ? job.company : "", job.location].filter(Boolean).join(", ")}
                right={dates(job)}
              >
                <Bullets items={job.bullets} />
              </Entry>
            ))}
          </Section>
        )}

        {resume.projects.length > 0 && (
          <Section title="Projects">
            {resume.projects.map((project, i) => (
              <Entry
                key={`${project.name}-${project.url}`}
                index={i}
                left={project.name}
                right={project.url ? shown(project.url) : undefined}
              >
                <Bullets items={project.bullets} />
              </Entry>
            ))}
          </Section>
        )}

        {resume.education.length > 0 && (
          <Section title="Education">
            {resume.education.map((school, i) => (
              <Entry
                key={`${school.school}-${school.degree}`}
                index={i}
                left={school.school || school.degree}
                sub={[school.school ? school.degree : "", school.location]
                  .filter(Boolean)
                  .join(", ")}
                right={dates(school)}
              >
                <Bullets items={school.details} />
              </Entry>
            ))}
          </Section>
        )}

        {resume.skills.some((group) => group.items.length > 0) && (
          <Section title="Skills">
            {resume.skills
              .filter((group) => group.items.length > 0)
              .map((group) => (
                <Text
                  key={group.label + group.items.join()}
                  style={{ marginTop: density.gap * 0.18 }}
                >
                  {group.label ? <Text style={s.strong}>{t(group.label)}: </Text> : null}
                  {t(group.items.join(", "))}
                </Text>
              ))}
          </Section>
        )}

        {resume.extras
          .filter((extra) => extra.items.some(Boolean))
          .map((extra) => (
            <Section key={extra.title} title={extra.title || "Other"}>
              <Bullets items={extra.items} />
            </Section>
          ))}
      </Page>
    </Document>
  );
}
