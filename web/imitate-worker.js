// Fits the copy-people network off the main thread (a second or two of maths).
import { decodeLives } from './shared/demos.js';
import { learnFromPeople, weightsToLinks } from './shared/imitate.js';

onmessage = (e) => {
  const { lives, nIn, id } = e.data;
  const data = decodeLives(lives, nIn);
  if (data.n < 50) return postMessage({ id, links: null, samples: data.n }); // ~10 s of play
  const { weights, agreement } = learnFromPeople(data);
  postMessage({ id, links: weightsToLinks(weights, nIn), agreement, samples: data.n, lives: lives.length });
};
