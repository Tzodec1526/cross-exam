/* Apply saved theme before React paints (avoids flash of wrong palette). */
try {
  var t = localStorage.getItem("cx-theme");
  if (t === "light" || t === "dark") {
    document.documentElement.setAttribute("data-theme", t);
  }
} catch (e) {
  /* private mode / blocked storage */
}
