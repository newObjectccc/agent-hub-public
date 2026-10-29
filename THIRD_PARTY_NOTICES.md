# Third-party runtime notices

The npm CLI distribution bundles its production dependencies. Each bundled
package retains its own license and attribution files. These packages are not
covered by Agent Hub's license unless their own license says otherwise.

`@earendil-works/pi-coding-agent` 0.99.1 is distributed under the MIT license.
Agent Hub applies the reproducible metadata patch in
`patches/@earendil-works__pi-coding-agent@0.99.1.patch`: its Undici dependency
and bundled npm lock are updated from 8.10.2 to the security release 8.12.2.
The SDK's JavaScript implementation, license, authorship, and version are
otherwise unchanged. This patched runtime is bundled so npm consumers do not
reinstall the SDK's vulnerable upstream lock.

The runtime bundle includes esbuild binaries for macOS, Linux, and Windows on
x64 and arm64. They retain their upstream licenses. The corresponding source
and package metadata are available from the packages' npm registry entries.
