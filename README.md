<!-- markdownlint-disable MD033 MD041 -->
<p align="center">
  <a href="https://stefanmschulz.github.io/TAC-4DGS_webpage">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/readme/banner-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset="assets/readme/banner-light.svg">
      <img src="assets/readme/banner-light.svg" width="100%" alt="TAC-4DGS: Trajectory-Aware Compression for Rate-Distortion Optimized 4D Gaussian Splatting (WACV 2027)">
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://stefanmschulz.github.io/TAC-4DGS_webpage"><img src="https://img.shields.io/badge/Project-Page-0f766e?style=for-the-badge&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJ3aGl0ZSIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjEwIi8%2BPHBhdGggZD0iTTEyIDJhMTQuNSAxNC41IDAgMCAwIDAgMjAgMTQuNSAxNC41IDAgMCAwIDAtMjAiLz48cGF0aCBkPSJNMiAxMmgyMCIvPjwvc3ZnPg%3D%3D&labelColor=161a1d" alt="Project page"></a>
  <a href="https://stefanmschulz.github.io/certificates/tac4dgs.pdf"><img src="https://img.shields.io/badge/Paper-PDF-0f766e?style=for-the-badge&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJ3aGl0ZSIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik0xNSAySDZhMiAyIDAgMCAwLTIgMnYxNmEyIDIgMCAwIDAgMiAyaDEyYTIgMiAwIDAgMCAyLTJWN1oiLz48cGF0aCBkPSJNMTQgMnY0YTIgMiAwIDAgMCAyIDJoNCIvPjxwYXRoIGQ9Ik0xNiAxM0g4Ii8%2BPHBhdGggZD0iTTE2IDE3SDgiLz48cGF0aCBkPSJNMTAgOUg4Ii8%2BPC9zdmc%2B&labelColor=161a1d" alt="Paper (PDF)"></a>
  <a href="https://github.com/StefanMSchulz/TAC-4DGS"><img src="https://img.shields.io/badge/Code-GitHub-0f766e?style=for-the-badge&logo=github&logoColor=white&labelColor=161a1d" alt="Code on GitHub"></a>
</p>

<p align="center">
  Source of the project page for our WACV&nbsp;2027 paper.<br>
  TAC-4DGS brings the trajectories of 4D Gaussian Splatting under rate-distortion optimized entropy coding:<br>
  <b>41.9%</b> smaller bitstreams on N3V and <b>33.8%</b> on Technicolor at nearly unchanged quality, with no changes to the renderer.
</p>

<p align="center">
  <a href="https://stefanmschulz.github.io/TAC-4DGS_webpage#viewer">
    <img src="assets/images/viewer-poster.jpg" width="80%" alt="Birthday scene from the interactive 4D viewer on the project page">
  </a>
  <br>
  <sub>Technicolor <i>Birthday</i>, decoded from the compressed bitstream and rendered live in the browser on the project page.</sub>
</p>
