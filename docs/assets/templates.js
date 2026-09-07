/* Filters the template list. An external file rather than an inline script
   because the site is served under script-src 'self', which blocks inline and
   leaves the control invisible with no error on the page. */
(function () {
  var box = document.querySelector(".filter");
  var input = document.getElementById("q");
  var empty = document.getElementById("empty");
  var plain = document.querySelector(".count-plain");
  if (!box || !input || !empty) return;

  var count = box.querySelector(".count");
  var atRest = count.textContent;
  var sections = [].slice.call(document.querySelectorAll("main section"));
  var rows = sections.map(function (section) {
    return [].slice
      .call(section.querySelectorAll("tbody tr"))
      .map(function (tr) {
        return { tr: tr, text: tr.textContent.toLowerCase() };
      });
  });

  box.hidden = false;
  if (plain) plain.hidden = true;

  input.addEventListener("input", function () {
    var term = input.value.trim().toLowerCase();
    var shown = 0;
    sections.forEach(function (section, index) {
      var visible = 0;
      rows[index].forEach(function (entry) {
        var match = term === "" || entry.text.indexOf(term) !== -1;
        entry.tr.hidden = !match;
        if (match) visible += 1;
      });
      section.hidden = visible === 0;
      shown += visible;
    });
    empty.hidden = shown !== 0;
    count.textContent =
      term === ""
        ? atRest
        : shown +
          (shown === 1 ? " template" : " templates") +
          " matching " +
          term;
  });
})();
