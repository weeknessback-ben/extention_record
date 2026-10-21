import { formatClock, formatDate, formatDuration, groupTranscript, labelsFor, platformName } from '@/lib/format';
import { t } from '@/lib/i18n';
import type { FrameRecord, MeetingSummary, Recording } from '@/lib/types';

/** The screenshots picked for the topics, by frame id. */
export type MinutesImages = ReadonlyMap<number, { url: string; frame: Pick<FrameRecord, 't' | 'width' | 'height'> }>;

function Paragraphs({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/\n{2,}|\r\n\r\n/)
        .filter((p) => p.trim())
        .map((p, i) => (
          <p key={i} dir="auto">
            {p.trim()}
          </p>
        ))}
    </>
  );
}

function List({ items, ordered }: { items: string[]; ordered?: boolean }) {
  const children = items.map((item, i) => (
    <li key={i} dir="auto">
      {item}
    </li>
  ));
  return ordered ? <ol>{children}</ol> : <ul>{children}</ul>;
}

/** The minutes document; rendered by the report page and, as static HTML, by the server for its PDF. */
export function Minutes({
  rec,
  s,
  includeTranscript,
  images,
}: {
  rec: Recording;
  s: MeetingSummary;
  includeTranscript: boolean;
  images: MinutesImages;
}) {
  const L = labelsFor(s);
  const transcript = includeTranscript ? groupTranscript(rec.transcript ?? []) : [];
  return (
    <>
      <header className="doc-head">
        <div className="kicker">{L.minutes}</div>
        <h1 dir="auto">{s.title || rec.title}</h1>
        <dl className="meta">
          <div>
            <dt>{L.date}</dt>
            <dd>{formatDate(rec.startedAt, s.language)}</dd>
          </div>
          <div>
            <dt>{L.duration}</dt>
            <dd>{formatDuration(rec.durationMs)}</dd>
          </div>
          <div>
            <dt>{L.platform}</dt>
            <dd>{platformName(rec.platform)}</dd>
          </div>
          {s.spokenLanguages.length > 0 && (
            <div>
              <dt>{L.spokenLanguages}</dt>
              <dd>{s.spokenLanguages.join(', ')}</dd>
            </div>
          )}
        </dl>
        {s.participants.length > 0 && (
          <div className="participants">
            <h3>{L.participants}</h3>
            <ul className="chips">
              {s.participants.map((p, i) => (
                <li key={i} dir="auto">
                  <strong>{p.name}</strong>
                  {p.role && <span> · {p.role}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </header>

      {s.executiveSummary && (
        <section className="summary">
          <h2>{L.executiveSummary}</h2>
          <Paragraphs text={s.executiveSummary} />
        </section>
      )}

      {s.keyPoints.length > 0 && (
        <section>
          <h2>{L.keyPoints}</h2>
          <List items={s.keyPoints} />
        </section>
      )}

      {s.topics.length > 0 && (
        <section>
          <h2>{L.topics}</h2>
          {s.topics.map((topic, i) => (
            <div className="topic" key={i}>
              <h3 dir="auto">
                {topic.time && <span className="time">{topic.time}</span>}
                {topic.title}
              </h3>
              {topic.summary && <Paragraphs text={topic.summary} />}
              {topic.points.length > 0 && <List items={topic.points} />}
              {topic.images.map((img) => {
                const image = images.get(img.id);
                if (!image) return null;
                return (
                  <figure key={img.id}>
                    <img src={image.url} width={image.frame.width} height={image.frame.height} alt={img.caption} />
                    <figcaption dir="auto">
                      <span className="time">{formatClock(image.frame.t / 1000)}</span>
                      {img.caption}
                    </figcaption>
                  </figure>
                );
              })}
            </div>
          ))}
        </section>
      )}

      {s.decisions.length > 0 && (
        <section>
          <h2>{L.decisions}</h2>
          <ol className="decisions">
            {s.decisions.map((d, i) => (
              <li key={i} dir="auto">
                <strong>{d.decision}</strong>
                {d.context && <div className="muted">{d.context}</div>}
              </li>
            ))}
          </ol>
        </section>
      )}

      {s.actionItems.length > 0 && (
        <section>
          <h2>{L.actionItems}</h2>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>{L.task}</th>
                <th>{L.owner}</th>
                <th>{L.deadline}</th>
                <th>{L.priority}</th>
              </tr>
            </thead>
            <tbody>
              {s.actionItems.map((a, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td dir="auto">{a.task}</td>
                  <td dir="auto">{a.owner}</td>
                  <td dir="auto">{a.deadline}</td>
                  <td dir="auto">{a.priority}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {s.openQuestions.length > 0 && (
        <section>
          <h2>{L.openQuestions}</h2>
          <List items={s.openQuestions} />
        </section>
      )}

      {s.nextSteps.length > 0 && (
        <section>
          <h2>{L.nextSteps}</h2>
          <List items={s.nextSteps} />
        </section>
      )}

      {s.timeline.length > 0 && (
        <section>
          <h2>{L.timeline}</h2>
          <table className="timeline">
            <tbody>
              {s.timeline.map((e, i) => (
                <tr key={i}>
                  <td className="time">{e.time}</td>
                  <td dir="auto">{e.event}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {transcript.length > 0 && (
        <section className="transcript">
          <h2>{L.transcript}</h2>
          {transcript.map((seg, i) => (
            <p key={i} dir="auto">
              <span className="time">{formatClock(seg.start)}</span>
              {seg.speaker && <strong>{seg.speaker}: </strong>}
              {seg.text}
            </p>
          ))}
        </section>
      )}

      <footer className="doc-foot">{t('report.generatedBy', { model: rec.summaryModel ?? '' })}</footer>
    </>
  );
}
