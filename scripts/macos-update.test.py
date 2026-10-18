import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('macos_update', Path(__file__).with_name('macos-update.py'))
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)

class FeedTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / 'macos').mkdir()
        self.original = update.ROOT
        update.ROOT = self.root
        self.addCleanup(setattr, update, 'ROOT', self.original)
        self.version = '0.4.0'
        self.sha = '1' * 40
        self.name = 'helium-synk-server-0.4.0-darwin-arm64.dmg'
        self.payload = self.root / self.name
        self.payload.write_bytes(b'isolated signing fixture')
        self.proof = self.root / 'helium-synk-server-0.4.0-darwin-arm64-build.json'
        self.proof.write_text(json.dumps({'source_commit': self.sha, 'uncommitted_changes': False, 'signed': True, 'notarized': True, 'sha256': hashlib.sha256(self.payload.read_bytes()).hexdigest()}))
        # A fresh ephemeral key exists only inside this subprocess; no production private key is used.
        script = '''const {generateKeyPairSync,sign}=require('node:crypto'); const fs=require('node:fs');
const root=process.argv[1],name=process.argv[2]; const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const raw=publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64');
fs.writeFileSync(root+'/macos/update-public-key.txt',raw);
const data=fs.readFileSync(root+'/'+name),sig=sign(null,data,privateKey).toString('base64');
const xml=Buffer.from(`<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item><sparkle:version>0.4.0</sparkle:version><enclosure url="https://github.com/mikr13/helium-synk/releases/download/v0.4.0/${name}" length="${data.length}" sparkle:edSignature="${sig}"/></item></channel></rss>\\n`);
fs.writeFileSync(root+'/appcast.xml',Buffer.concat([xml,Buffer.from(`<!-- sparkle-signatures:\\nedSignature: ${sign(null,xml,privateKey).toString('base64')}\\nlength: ${xml.length}\\n-->\\n`)]));'''
        subprocess.run(['node','-e',script,str(self.root),self.name],check=True)
        self.feed = self.root / 'appcast.xml'
    def verify(self):
        update.verify(self.feed, self.root, self.version, self.sha)
    def testValidSignedPayloadAndFeed(self):
        self.verify()
    def testUnsignedFeedRejectedEvenWhenPayloadIsSigned(self):
        self.feed.write_bytes(self.feed.read_bytes().split(b'<!-- sparkle-signatures:')[0])
        with self.assertRaisesRegex(ValueError, 'unsigned'): self.verify()
    def testModifiedFeedRejected(self):
        self.feed.write_bytes(self.feed.read_bytes().replace(b'<channel>', b'<channel> '))
        with self.assertRaisesRegex(ValueError, 'length|signature'): self.verify()
    def testModifiedPayloadRejectedEvenWithUpdatedChecksum(self):
        self.payload.write_bytes(b'changed signing fixture!')
        proof=json.loads(self.proof.read_text())
        proof['sha256']=hashlib.sha256(self.payload.read_bytes()).hexdigest()
        self.proof.write_text(json.dumps(proof))
        with self.assertRaisesRegex(ValueError, 'signature'): self.verify()
    def testOtherSourceOrDirtyBuildRejected(self):
        self.sha='2'*40
        with self.assertRaisesRegex(ValueError, 'source'): self.verify()
        self.sha='1'*40
        proof=json.loads(self.proof.read_text()); proof['uncommitted_changes']=True
        self.proof.write_text(json.dumps(proof))
        with self.assertRaisesRegex(ValueError, 'source'): self.verify()
    def testWrongEmbeddedPublicKeyRejected(self):
        (self.root / 'macos/update-public-key.txt').write_text('A'*43+'=')
        with self.assertRaisesRegex(ValueError, 'signature'): self.verify()

if __name__ == '__main__': unittest.main()
