export const REVIEW_METHOD_IDS = Object.freeze(['standard', 'deep', 'xhigh']);

export const REVIEW_METHODS = Object.freeze({
  standard: Object.freeze({
    id: 'standard',
    titleKey: 'review.method.standard.title',
    labelKey: 'review.method.standard.label',
    descriptionKey: 'review.method.standard.description',
    progressKey: 'review.method.standard.progress',
    nextId: 'deep',
    recommended: true
  }),
  deep: Object.freeze({
    id: 'deep',
    titleKey: 'review.method.deep.title',
    labelKey: 'review.method.deep.label',
    descriptionKey: 'review.method.deep.description',
    progressKey: 'review.method.deep.progress',
    nextId: 'xhigh',
    recommended: false
  }),
  xhigh: Object.freeze({
    id: 'xhigh',
    titleKey: 'review.method.xhigh.title',
    labelKey: 'review.method.xhigh.label',
    descriptionKey: 'review.method.xhigh.description',
    progressKey: 'review.method.xhigh.progress',
    nextId: null,
    recommended: false
  })
});

export function getReviewMethod(id) {
  return REVIEW_METHODS[id] ?? REVIEW_METHODS.standard;
}

export function getNextReviewMethod(id) {
  const nextId = getReviewMethod(id).nextId;
  return nextId ? REVIEW_METHODS[nextId] : null;
}

export function reviewMethodCopy(t, id) {
  const method = getReviewMethod(id);
  const translate = typeof t === 'function' ? t : (_key, fallback) => fallback;
  return {
    ...method,
    title: translate(method.titleKey, method.id === 'standard'
      ? 'Find the improvements that matter most'
      : method.id === 'deep'
        ? 'Find improvements in more detail'
        : 'Review carefully before an important decision'),
    label: translate(method.labelKey, method.id === 'standard'
      ? 'Essential review'
      : method.id === 'deep'
        ? 'Detailed review'
        : 'Careful review'),
    description: translate(method.descriptionKey, method.id === 'standard'
      ? 'Focus on the most important points and make the next improvements clear.'
      : method.id === 'deep'
        ? 'Review usability and content in detail from several perspectives.'
        : 'Review the result more than once to reduce important omissions.'),
    progress: translate(method.progressKey, method.id === 'standard'
      ? 'Checking the improvements that matter most'
      : method.id === 'deep'
        ? 'Checking in detail from several perspectives'
        : 'Checking evidence and possible omissions carefully'),
    recommendedLabel: method.recommended
      ? translate('review.method.recommended', 'Recommended')
      : ''
  };
}
