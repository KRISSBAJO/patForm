/**
 * Makes a self-issued seal certificate for Patform Sign, for trials and for
 * workspaces that do not need Adobe's "trusted" label.
 *
 *   npx tsx scripts/make-seal-certificate.mts "Patform Sign" "a strong passphrase"
 *
 * Prints SIGN_SEAL_P12_BASE64 and SIGN_SEAL_PASSPHRASE for .env. A PDF reader
 * will show the seal and catch any change, but call the signer "unknown"
 * because nobody vouches for this certificate. For a trusted label, buy a
 * document-signing certificate from a provider on Adobe's trusted list and
 * put its .p12 here instead.
 */
import forge from 'node-forge';

const [name = 'Patform Sign', passphrase = ''] = process.argv.slice(2);
if (passphrase.length < 12) { console.error('give a passphrase of at least 12 characters'); process.exit(1); }
const keys = forge.pki.rsa.generateKeyPair(3072);
const cert = forge.pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16)).replace(/^[89a-f]/, '1');
cert.validity.notBefore = new Date();
cert.validity.notAfter = new Date(Date.now() + 3 * 365 * 86400000);
const attrs = [{ name: 'commonName', value: name }, { name: 'organizationName', value: name }];
cert.setSubject(attrs); cert.setIssuer(attrs);
cert.setExtensions([{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true, nonRepudiation: true }, { name: 'extKeyUsage', emailProtection: true }]);
cert.sign(keys.privateKey, forge.md.sha256.create());
const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], passphrase, { algorithm: '3des' });
console.log(`SIGN_SEAL_P12_BASE64=${Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary').toString('base64')}`);
console.log(`SIGN_SEAL_PASSPHRASE=${passphrase}`);
