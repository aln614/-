# Native backdrop prototype

This is an isolated experiment, not a production integration. The native
composition effect is a Gaussian backdrop blur; it does not by itself
implement liquid refraction.

`inproc.cs` avoids changing the process-wide DLL search path. It explicitly
loads the Win2D native DLL from the manifest directory and scopes activation
contexts to calls that create effects. `AddWindow`, `SetBlur`, and
`RemoveWindow` exercise per-window lifetime.

The test currently depends on locally prepared files in
`%TEMP%\tenying-composition-probe`. The `inproc-safe.dll` test binary must be
rebuilt after changing `inproc.cs`. `build.ps1` also prepares pinned NuGet
dependencies and a fresh bridge build in a new output directory; the Win2D
package declares separate license terms requiring acceptance, which must be
checked before redistribution.

On the development machine, the following verifies the actual application
page in an isolated temporary profile and server:

```powershell
$env:TENYING_TEST_SAFE_DLL='1'
$env:TENYING_TEST_REAL_UI='1'
node prototypes/native-glass/test-inproc.js
```

The test checks pixel changes for low and high blur, a changing background,
an appearance button, resize, maximize/restore, and a second window's basic
lifecycle.

`node prototypes/native-glass/test-integration.js` tests the opt-in bridge in
isolated host and LAN client processes. It checks native screen pixel changes,
the four outer corners, physical window dragging, repeated mode switches,
reload persistence, and opening the asset and prompt library windows. Screen
captures are compared in memory and are not saved by this integration test.
It can run against source or isolated experimental packaged builds.

The separate experimental host and LAN client packaged builds have passed the
integration test and a missing-runtime fallback test for the host. They still
require sustained-load and wider machine compatibility validation. Native
runtime loading currently depends on the experimental environment variable
and is intentionally disabled by default.

An isolated Windows Composition capability probe found that
`DisplacementMapEffect` returns `Unsupported effect type`, while a
`Transform2DEffect` factory can be created. Therefore the present native
effect provides live blur but does not reproduce the upstream component's
displacement-map refraction on the desktop backdrop. The existing React
component still provides refraction for supported in-page surfaces.

Before production use, provide reproducible, licensed dependencies and a
packaged native bridge; verify failure recovery, cleanup, device-local
settings and mode switching; test both packaged applications and their
standalone library windows; then validate the visual appearance and restart
only after those checks pass.
