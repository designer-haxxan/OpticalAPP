// Login link helper: opening  <app>/#u=<username>&p=<password>  (values encodeURIComponent-encoded) fills the login form.
// Loaded as a classic script BEFORE js/app.js, so the credentials leave the address bar before the router reads the hash.
// The credentials stay in memory only until the fields are filled; the form is never submitted automatically.
(function () {
  var params = new URLSearchParams(location.hash.replace(/^#/, ''));
  var u = params.get('u'); var p = params.get('p');
  params = null;
  if (u === null || p === null) return; // no link, only one value, or a normal route such as #/dashboard: do nothing
  history.replaceState(null, '', location.pathname + location.search);

  var tries = 0;
  (function fill() {
    var user = document.getElementById('login-username');
    var pass = document.getElementById('login-password');
    // Wait until the login screen is actually showing; if the user is already signed in it never appears.
    var visible = user && pass && user.offsetParent !== null;
    if (!visible) { if (++tries < 100) setTimeout(fill, 100); else { u = p = null; } return; }
    user.value = u; pass.value = p;
    user.dispatchEvent(new Event('input', { bubbles: true }));
    pass.dispatchEvent(new Event('input', { bubbles: true }));
    u = p = null;
    var hint = document.getElementById('autofill-hint');
    var btn = document.getElementById('login-btn');
    if (hint) hint.classList.remove('d-none');
    if (btn) {
      btn.classList.add('pulse-cta');
      var form = document.getElementById('login-form');
      if (form) form.addEventListener('submit', function () { btn.classList.remove('pulse-cta'); if (hint) hint.classList.add('d-none'); }, { once: true });
    }
  })();
})();
