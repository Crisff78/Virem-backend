
const axios = require('axios');

async function testRegister() {
    const body = {
        nombres: 'Yaslyn',
        apellidos: 'Castillo',
        fechanacimiento: '13/11/2000',
        genero: 'Mujer',
        cedula: '001-1276244-8',
        telefono: '8091234567',
        email: 'test_yaslyn_' + Date.now() + '@example.com',
        password: 'Password123!'
    };

    try {
        console.log('Testing registration against localhost:3000...');
        const response = await axios.post('http://localhost:3000/api/auth/register', body, {
            validateStatus: () => true
        });

        console.log('Status:', response.status);
        console.log('Response:', JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
}

testRegister();
