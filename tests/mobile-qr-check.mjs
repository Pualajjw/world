/** Independent QR decoding with the developer machine's Python/OpenCV; never a runtime dependency. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { qrMatrix, qrSvg } from '../mobile-qr.js'

const values = [1, 18, 33, 54, 79, 107, 135, 155, 193, 231].map((length, i) => String(i).repeat(length))
values.push('http://192.168.1.3:53319/#world-pair=' + 'Abc123_-'.repeat(5) + 'abc')
const cases = values.map(value => ({ value, matrix: qrMatrix(value) }))
for (let i = 0; i < 10; i++) assert.equal(cases[i].matrix.length, 21 + i * 4)
assert.throws(() => qrMatrix('x'.repeat(300)), /过长/)
assert.match(qrSvg(values[0]), /viewBox="0 0 29 29"/)
const code = `import sys,json,cv2,numpy as np
rows=json.load(sys.stdin)
decoder=cv2.QRCodeDetector()
results=[]
for row in rows:
    data=np.array(row['matrix'],dtype=np.uint8)
    image=np.pad(255-data*255,4,constant_values=255)
    image=np.repeat(np.repeat(image,8,axis=0),8,axis=1)
    text,points,_=decoder.detectAndDecode(image)
    results.append(text==row['value'])
print(json.dumps(results))`
const results = JSON.parse(execFileSync(process.env.WORLD_TEST_PYTHON || 'python', ['-c', code], { input: JSON.stringify(cases), encoding: 'utf8', windowsHide: true, timeout: 30000 }))
assert.deepEqual(results, values.map(() => true))
console.log('OpenCV independently decoded all QR versions 1–10 and the phone pairing URL.')
