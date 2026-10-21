🐷 Kaching - The Chore Rewards App

Welcome to Kaching, a fun and interactive web app designed to motivate kids to complete their chores, earn points, and redeem awesome prizes!

This app runs entirely in your web browser, requires absolutely no login or database setup, and features a built-in parental approval system.

✨ Features

No Login Required: Uses your browser's Local Storage to save points, chores, and prizes instantly.

Chore Management: Kids can add their own chores and set the point values.

AI Suggestions: Stuck on what to clean? Use the "Suggest Fun Chores" button for quick ideas!

Prize Room: Redeem hard-earned points for rewards like Extra Screen Time, Movie Nights, or New Toys.

Parental Approval System:

Kids enter a parent's email address when they first open the app.

When a chore is finished, kids can instantly generate an email draft with a "Magic Link."

Parents click the link in their email to magically approve the chore and award the points!

Beautiful UI: Features a vibrant, animated gradient background and modern "glassmorphism" design.

🛠️ Tech Stack

HTML5

CSS3 (Styled with Tailwind CSS via CDN)

JavaScript (Vanilla JS for all logic and state management)

Icons: FontAwesome

📝 How it Works (The Magic Link)

Because Kaching doesn't use a backend server, it uses URL Parameters to handle parent approvals.
When a kid finishes a chore, the app creates a link that looks like this:
yourwebsite.com/?approve_chore=123&pts=50

When the parent clicks this link, the app reads the URL, finds the matching chore, deletes it from the pending list, and adds the points to the balance!
