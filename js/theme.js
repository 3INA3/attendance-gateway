try {
  var th = localStorage.getItem('att_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', th);
} catch (e) {}
