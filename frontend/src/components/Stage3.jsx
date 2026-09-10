import ReactMarkdown from 'react-markdown';
import { markdownComponents, remarkGfmPlugin } from '../markdownComponents';
import CopyButton from './CopyButton';
import './Stage3.css';

function shortName(model) {
  if (!model) return '';
  return model.split('/')[1] || model;
}

function displayNameForIndex(index, labelToModel) {
  if (index == null || !labelToModel) return null;
  const label = `Response ${index + 1}`;
  const model = labelToModel[label];
  if (!model) return null;

  const totals = {};
  Object.values(labelToModel).forEach((id) => {
    totals[id] = (totals[id] || 0) + 1;
  });
  if (totals[model] <= 1) return shortName(model);

  let count = 0;
  const labels = Object.keys(labelToModel).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
  for (const key of labels) {
    if (labelToModel[key] === model) {
      count += 1;
      if (key === label) return `${shortName(model)} #${count}`;
    }
  }
  return shortName(model);
}

export default function Stage3({
  finalResponse,
  consensus,
  labelToModel,
  topKIndices,
}) {
  if (!finalResponse) {
    return null;
  }

  const level = finalResponse.consensus_level || consensus?.level;
  const basedOn =
    finalResponse.based_on_index ?? consensus?.leader_index ?? null;
  const basedOnName = displayNameForIndex(basedOn, labelToModel);
  const extraCount = Math.max((topKIndices?.length || 1) - 1, 0);

  return (
    <div className="stage stage3">
      <h3 className="stage-title">Stage 3: Final Council Answer</h3>
      <div className="final-response">
        <div className="chairman-row">
          <div className="chairman-label">
            Chairman: {shortName(finalResponse.model)}
          </div>
          {level && (
            <span className={`confidence-badge confidence-${level.toLowerCase()}`}>
              {level}
            </span>
          )}
        </div>
        {basedOnName && (
          <div className="based-on-label">
            Based on: {basedOnName}
            {extraCount > 0 && ` (+${extraCount} candidate${extraCount === 1 ? '' : 's'})`}
          </div>
        )}
        <div className="final-text markdown-content">
          <ReactMarkdown remarkPlugins={[remarkGfmPlugin]} components={markdownComponents}>
            {finalResponse.response}
          </ReactMarkdown>
        </div>
        <div className="copy-row">
          <CopyButton text={finalResponse.response} label="Copy answer" />
        </div>
      </div>
    </div>
  );
}
