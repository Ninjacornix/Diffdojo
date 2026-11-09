'use strict';
// Minimal glob matcher: supports **, *, ?, {a,b} and character classes.
// Patterns without a slash match against the basename (gitignore-style).

const cache = new Map();

function globToRegex(glob) {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // '**/' matches zero or more directories; trailing '**' matches everything.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end < 0) {
        re += '\\{';
        i++;
      } else {
        const alts = glob.slice(i + 1, end).split(',').map((a) => globToRegex(a).source.slice(1, -1));
        re += '(?:' + alts.join('|') + ')';
        i = end + 1;
      }
    } else if (c === '[') {
      const end = glob.indexOf(']', i);
      if (end < 0) {
        re += '\\[';
        i++;
      } else {
        re += glob.slice(i, end + 1).replace(/^\[!/, '[^');
        i = end + 1;
      }
    } else {
      re += c.replace(/[.+^$()|\\]/g, '\\$&');
      i++;
    }
  }
  return new RegExp('^' + re + '$');
}

function compile(glob) {
  let r = cache.get(glob);
  if (!r) {
    r = globToRegex(glob);
    cache.set(glob, r);
  }
  return r;
}

function matches(file, glob) {
  const f = file.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!glob.includes('/')) {
    const base = f.slice(f.lastIndexOf('/') + 1);
    return compile(glob).test(base);
  }
  return compile(glob).test(f);
}

function matchesAny(file, globs) {
  return (globs || []).some((g) => matches(file, g));
}

module.exports = { matches, matchesAny, globToRegex };
