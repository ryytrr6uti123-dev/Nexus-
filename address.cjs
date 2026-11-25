function isWebUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function resolveAddress(value, searchEngine = 'duckduckgo') {
  const input = value.trim();
  if (!input) {
    throw new Error('Enter a search or web address.');
  }

  const searchUrls = {
    duckduckgo: 'https://duckduckgo.com/?q=',
    bing: 'https://www.bing.com/search?q=',
  };
  if (!Object.hasOwn(searchUrls, searchEngine)) {
    throw new Error('Choose a supported search engine.');
  }

  if (/^https?:\/\//i.test(input)) {
    if (!isWebUrl(input)) {
      throw new Error('Only http and https addresses are supported.');
    }
    return input;
  }

  const looksLikeHost = /^[\w.-]+(?::\d+)?(?:[/?#].*)?$/.test(input)
    && (input.includes('.') || /^localhost(?::\d+)?/i.test(input));
  if (!/\s/.test(input) && looksLikeHost) {
    const address = `https://${input}`;
    if (isWebUrl(address)) {
      return address;
    }
  }

  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(input)) {
    throw new Error('Only http and https addresses are supported.');
  }

  return `${searchUrls[searchEngine]}${encodeURIComponent(input)}`;
}

module.exports = { isWebUrl, resolveAddress };
