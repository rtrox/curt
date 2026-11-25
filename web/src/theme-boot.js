// Runs before first paint, as a classic blocking script, so the saved theme and accent never flash.
(function () {
  try {
    var root = document.documentElement;
    var theme = localStorage.getItem('curt.theme');
    if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
    var accent = JSON.parse(localStorage.getItem('curt.accent') || 'null');
    if (accent) {
      ['accent-l', 'on-l', 'accent-d', 'on-d'].forEach(function (key) {
        if (/^#[0-9a-f]{6}$/i.test(accent[key])) root.style.setProperty('--' + key, accent[key]);
      });
    }
  } catch (e) {
    // Storage is blocked or holds something unexpected: the system theme applies.
  }
})();
