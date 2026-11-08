// Fills in the contact address on the legal pages from config.js.
(function () {
  var cfg = window.HAPPYNESS_CONFIG || {};
  var email = cfg.contactEmail || '';
  document.querySelectorAll('[data-contact]').forEach(function (el) {
    if (email) {
      var a = document.createElement('a');
      a.href = 'mailto:' + email;
      a.textContent = email;
      el.replaceChildren(a);
    }
  });
})();
