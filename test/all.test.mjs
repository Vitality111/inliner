// Один test entry-point тримає native-залежності (зокрема sharp) в одному
// процесі та лишається сумісним із мінімальною заявленою версією Node 18.
import './html.test.mjs';
import './html-noise.test.mjs';
import './mime.test.mjs';
import './validation.test.mjs';
