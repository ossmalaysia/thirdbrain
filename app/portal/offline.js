// Offline page (served by the service worker when a navigation fails): Retry reloads the page the user asked for.
document.getElementById('retry').addEventListener('click', () => location.reload());
