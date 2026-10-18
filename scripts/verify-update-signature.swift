// Confirms that an EdDSA signature over an update archive verifies against the
// SUPublicEDKey shipped in the app, so a mismatched signing secret fails the release
// instead of breaking updates for every installed copy.
//
// Usage: swift verify-update-signature.swift <archive> <signature> <public-key>

import CryptoKit
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("\(message)\n".utf8))
  exit(1)
}

let arguments = CommandLine.arguments
guard arguments.count == 4 else {
  fail("Usage: verify-update-signature.swift <archive> <signature> <public-key>")
}

guard let archive = FileManager.default.contents(atPath: arguments[1]) else {
  fail("Could not read \(arguments[1])")
}
guard let signature = Data(base64Encoded: arguments[2]) else {
  fail("The signature is not base64")
}
guard let keyData = Data(base64Encoded: arguments[3]),
  let publicKey = try? Curve25519.Signing.PublicKey(rawRepresentation: keyData)
else {
  fail("SUPublicEDKey is not an Ed25519 public key")
}
guard publicKey.isValidSignature(signature, for: archive) else {
  fail(
    "The update signature does not match SUPublicEDKey. Check the SPARKLE_ED_PRIVATE_KEY secret.")
}

print("Update signature matches SUPublicEDKey")
